import { serve } from "@hono/node-server";

import { loadConfig, ensureDataDir } from "./config.js";
import { logger } from "./lib/logger.js";
import { initDatabase } from "./lib/db.js";
import { state } from "./lib/state.js";
import { setupGitHubToken } from "./auth/github-token.js";
import { setupCopilotToken } from "./auth/copilot-token.js";
import { setupDeepseekToken } from "./auth/deepseek-token.js";
import { cacheModels } from "./services/copilot-models.js";
import { app } from "./server.js";

async function main() {
  const config = loadConfig();

  // Configure logging
  if (config.verbose) {
    logger.setLevel("debug");
    logger.info("Verbose logging enabled");
  }

  // Configure state
  state.accountType = config.accountType;
  state.vsCodeVersion = config.vsCodeVersion;
  state.rateLimitSeconds = config.rateLimitSeconds;
  state.apiKey = config.apiKey;

  if (config.apiKey) {
    logger.info("API key authentication enabled");
  }

  if (config.accountType !== "individual") {
    logger.info(`Using ${config.accountType} Copilot account`);
  }

  // Ensure data directory exists
  await ensureDataDir(config.dataDir);

  // Initialize usage tracking database
  await initDatabase(config.dataDir);

  // Setup GitHub token
  await setupGitHubToken({
    dataDir: config.dataDir,
    providedToken: config.githubToken,
    force: config.authOnly,
  });

  // Auth-only mode: exit after getting token
  if (config.authOnly) {
    logger.info("Auth completed. Token saved.");
    process.exit(0);
  }

  // Exchange for Copilot token
  await setupCopilotToken();

  // Setup DeepSeek API key (independent of Copilot, no device flow needed)
  await setupDeepseekToken({
    dataDir: config.dataDir,
    providedToken: config.deepseekApiKey,
  });

  // Cache available models
  await cacheModels();

  if (state.models) {
    logger.info(
      `Available models:\n${state.models.data.map((m) => `  - ${m.id}`).join("\n")}`
    );
  }

  // Start the server
  const server = serve({
    fetch: app.fetch,
    port: config.port,
  });

  logger.info(`CopilotProxyServer running on http://localhost:${config.port}`);
  logger.info("");
  logger.info("Endpoints:");
  logger.info(`  OpenAI:     POST http://localhost:${config.port}/v1/chat/completions`);
  logger.info(`  Anthropic:  POST http://localhost:${config.port}/v1/messages`);
  logger.info(`  Gemini:     POST http://localhost:${config.port}/v1beta/models/{model}:generateContent`);
  logger.info(`  Gemini SSE: POST http://localhost:${config.port}/v1beta/models/{model}:streamGenerateContent`);
  logger.info(`  Models:     GET  http://localhost:${config.port}/v1/models`);
  logger.info(`  Health:     GET  http://localhost:${config.port}/`);
  logger.info(`  Dashboard:  GET  http://localhost:${config.port}/dashboard`);
}

main().catch((error) => {
  logger.error("Failed to start server:", error);
  process.exit(1);
});
