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
  copilotEnabled: boolean;
  lokiEnabled: boolean;
  lokiEnvironment: "prod" | "msit" | "sdf";
  lokiAuthOnly: boolean;
  lokiDeviceCode: boolean;
}

function getDataDir(): string {
  const envDir = process.env.DATA_DIR;
  if (envDir) return envDir;
  if (process.platform === "win32") {
    return path.join(os.homedir(), ".copilot-proxy");
  }
  return path.join(os.homedir(), ".local", "share", "copilot-proxy");
}

function enabled(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

export function loadConfig(): Config {
  const args = process.argv.slice(2);
  const authOnly = args.includes("--auth");
  const lokiAuthOnly = args.includes("--loki-auth");
  if (authOnly && lokiAuthOnly) throw new Error("Choose --auth or --loki-auth, not both.");
  const lokiEnvironment = process.env.LOKI_ENVIRONMENT || "prod";
  if (lokiEnvironment !== "prod" && lokiEnvironment !== "msit" && lokiEnvironment !== "sdf") {
    throw new Error("LOKI_ENVIRONMENT must be prod, msit, or sdf.");
  }
  const copilotEnabled = enabled("COPILOT_ENABLED", true);
  const lokiEnabled = enabled("LOKI_ENABLED", false);
  if (!authOnly && !lokiAuthOnly && !copilotEnabled && !lokiEnabled) {
    throw new Error("Enable at least one provider: COPILOT_ENABLED or LOKI_ENABLED.");
  }
  const rateLimitRaw = process.env.RATE_LIMIT_SECONDS;
  const rateLimit = rateLimitRaw !== undefined ? parseInt(rateLimitRaw, 10) : undefined;

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
    copilotEnabled,
    lokiEnabled,
    lokiEnvironment,
    lokiAuthOnly,
    lokiDeviceCode: args.includes("--device-code"),
  };
}

export async function ensureDataDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}
