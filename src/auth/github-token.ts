import fs from "node:fs/promises";
import path from "node:path";

import { logger } from "../lib/logger.js";
import { state } from "../lib/state.js";
import { getDeviceCode, pollAccessToken } from "./device-flow.js";
import { GITHUB_API_BASE_URL, githubHeaders } from "./api-config.js";

function getTokenPath(dataDir: string): string {
  return path.join(dataDir, "github_token");
}

async function readGithubToken(dataDir: string): Promise<string> {
  try {
    const token = await fs.readFile(getTokenPath(dataDir), "utf8");
    return token.trim();
  } catch {
    return "";
  }
}

async function writeGithubToken(
  dataDir: string,
  token: string
): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(getTokenPath(dataDir), token, { mode: 0o600 });
}

interface SetupOptions {
  dataDir: string;
  providedToken?: string;
  force?: boolean;
}

export async function setupGitHubToken(options: SetupOptions): Promise<void> {
  // Priority 1: provided token (from env var)
  if (options.providedToken) {
    state.githubToken = options.providedToken;
    logger.info("Using provided GitHub token");
    await logUser();
    return;
  }

  // Priority 2: saved token from file
  if (!options.force) {
    const savedToken = await readGithubToken(options.dataDir);
    if (savedToken) {
      state.githubToken = savedToken;
      logger.info("Using saved GitHub token");
      await logUser();
      return;
    }
  }

  // Priority 3: Device Flow
  logger.info("No GitHub token found, starting Device Flow authentication...");
  const deviceCode = await getDeviceCode();

  console.log("\n========================================");
  console.log(`  Please visit: ${deviceCode.verification_uri}`);
  console.log(`  Enter code:   ${deviceCode.user_code}`);
  console.log("========================================\n");

  const token = await pollAccessToken(deviceCode);
  await writeGithubToken(options.dataDir, token);
  state.githubToken = token;

  logger.info("GitHub token saved");
  await logUser();
}

async function logUser(): Promise<void> {
  try {
    const response = await fetch(`${GITHUB_API_BASE_URL}/user`, {
      headers: githubHeaders(state),
    });

    if (response.ok) {
      const user = (await response.json()) as { login: string };
      logger.info(`Logged in as ${user.login}`);
    }
  } catch (error) {
    logger.warn("Failed to fetch user info:", error);
  }
}
