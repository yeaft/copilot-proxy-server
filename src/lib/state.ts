import type { ModelsResponse } from "../types/copilot.js";

export interface State {
  githubToken?: string;
  copilotToken?: string;
  apiKey?: string;
  accountType: string;
  models?: ModelsResponse;
  vsCodeVersion: string;
  rateLimitSeconds?: number;
  rateLimitWait: boolean;
  lastRequestTimestamp?: number;
}

export const state: State = {
  accountType: "individual",
  vsCodeVersion: "1.109.2",
  rateLimitWait: false,
};
