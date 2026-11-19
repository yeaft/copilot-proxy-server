import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface Config {
  port: number;
  githubToken?: string;
  apiKey?: string;
  deepseekApiKey?: string;
  accountType: string;
  verbose: boolean;
  rateLimitSeconds?: number;
  vsCodeVersion: string;
  dataDir: string;
  authOnly: boolean;
}

function getDataDir(): string {
  const envDir = process.env.DATA_DIR;
  if (envDir) return envDir;
  if (process.platform === "win32") {
    return path.join(os.homedir(), ".copilot-proxy");
  }
  return path.join(os.homedir(), ".local", "share", "copilot-proxy");
}

export function loadConfig(): Config {
  const args = process.argv.slice(2);
  const authOnly = args.includes("--auth");

  const rateLimitRaw = process.env.RATE_LIMIT_SECONDS;
  const rateLimit =
    rateLimitRaw !== undefined ? parseInt(rateLimitRaw, 10) : undefined;

  return {
    port: parseInt(process.env.PORT || "6628", 10),
    githubToken: process.env.GITHUB_TOKEN,
    apiKey: process.env.API_KEY,
    deepseekApiKey: process.env.DEEPSEEK_API_KEY,
    accountType: process.env.ACCOUNT_TYPE || "individual",
    verbose: process.env.VERBOSE === "true",
    rateLimitSeconds: rateLimit,
    vsCodeVersion: process.env.VSCODE_VERSION || "1.109.2",
    dataDir: getDataDir(),
    authOnly,
  };
}

export async function ensureDataDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}
