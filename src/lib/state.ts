import type { ModelsResponse } from "../types/copilot.js";
import type { LokiProvider } from "../services/loki.js";

export interface State {
  githubToken?: string;
  copilotToken?: string;
  apiKey?: string;
  deepseekApiKey?: string;
  accountType: string;
  models?: ModelsResponse;
  copilotEnabled: boolean;
  loki?: LokiProvider;
  vsCodeVersion: string;
  rateLimitSeconds?: number;
  rateLimitWait: boolean;
  lastRequestTimestamp?: number;
}

export const state: State = {
  copilotEnabled: true,
  accountType: "individual",
  vsCodeVersion: "1.109.2",
  rateLimitWait: false,
};
