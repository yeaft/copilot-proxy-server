import { serve } from "@hono/node-server";
import { join } from "node:path";
import { LokiAuthentication } from "./auth/loki-auth.js";
import { LokiProvider } from "./services/loki.js";

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
  state.copilotEnabled = config.copilotEnabled;

  if (config.apiKey) {
    logger.info("API key authentication enabled");
  }

  if (config.accountType !== "individual") {
    logger.info(`Using ${config.accountType} Copilot account`);
  }

  // Ensure data directory exists
  await ensureDataDir(config.dataDir);

  // Explicit authentication commands do not start HTTP servers or modify usage databases.
  if (config.lokiAuthOnly) {
    const auth = new LokiAuthentication(join(config.dataDir, "loki"));
    await auth.signIn(config.lokiDeviceCode, (message) => logger.info(message));
    logger.info("Microsoft Loki sign-in completed. Credentials saved in DATA_DIR/loki/auth.");
    return;
  }
  if (config.authOnly) {
    await setupGitHubToken({ dataDir: config.dataDir, providedToken: config.githubToken, force: true });
    logger.info("GitHub authentication completed. Token saved.");
    return;
  }

  await initDatabase(config.dataDir);

  if (config.lokiEnabled) {
    state.loki = new LokiProvider({
      tokens: new LokiAuthentication(join(config.dataDir, "loki")),
      environment: config.lokiEnvironment,
    });
    // Never initiate interactive login during server startup (especially in Docker).
    logger.info(`Native Microsoft Loki provider enabled (${config.lokiEnvironment}).`);
  }

  if (config.copilotEnabled) {
    await setupGitHubToken({ dataDir: config.dataDir, providedToken: config.githubToken });
    await setupCopilotToken();
    await cacheModels();
  }

  // Setup DeepSeek API key (independent of Copilot, no device flow needed)
  await setupDeepseekToken({
    dataDir: config.dataDir,
    providedToken: config.deepseekApiKey,
  });

  if (state.models) {
    logger.info(
      `Available models:\n${state.models.data.map((m) => `  - ${m.id}`).join("\n")}`
    );
  }

  // Start the server
  serve({
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
