import { copilotBaseUrl, copilotHeaders } from "../auth/api-config.js";
import { HTTPError } from "../lib/error.js";
import { state } from "../lib/state.js";
import type { ModelsResponse } from "../types/copilot.js";

export async function getModels(): Promise<ModelsResponse> {
  const response = await fetch(`${copilotBaseUrl(state)}/models`, {
    headers: copilotHeaders(state),
  });

  if (!response.ok) {
    throw new HTTPError("Failed to get models", response);
  }

  return (await response.json()) as ModelsResponse;
}

export async function cacheModels(): Promise<void> {
  const models = await getModels();
  state.models = models;
}
