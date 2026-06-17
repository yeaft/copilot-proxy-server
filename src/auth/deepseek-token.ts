import fs from "node:fs/promises";
import path from "node:path";

import { logger } from "../lib/logger.js";
import { state } from "../lib/state.js";

function getTokenPath(dataDir: string): string {
  return path.join(dataDir, "deepseek_token");
}

async function readDeepseekToken(dataDir: string): Promise<string> {
  try {
    const token = await fs.readFile(getTokenPath(dataDir), "utf8");
    return token.trim();
  } catch {
    return "";
  }
}

async function writeDeepseekToken(
  dataDir: string,
  token: string
): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(getTokenPath(dataDir), token, { mode: 0o600 });
}

interface SetupOptions {
  dataDir: string;
  providedToken?: string;
}

export async function setupDeepseekToken(options: SetupOptions) {
  const { dataDir, providedToken } = options;

  const savedToken = await readDeepseekToken(dataDir);

  // Priority: provided token > saved token
  const token = providedToken || savedToken;

  if (!token) {
    logger.warn(
      "DeepSeek API key not configured (set DEEPSEEK_API_KEY env or save to deepseek_token)"
    );
    return;
  }

  // If provided token differs from saved, update the file
  if (providedToken && providedToken !== savedToken) {
    await writeDeepseekToken(dataDir, providedToken);
    logger.info("DeepSeek API key updated from environment");
  } else if (savedToken) {
    logger.info("DeepSeek API key loaded from saved token");
  }

  state.deepseekApiKey = token;
}
