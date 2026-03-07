import { GITHUB_API_BASE_URL, githubHeaders, copilotHeaders } from "./api-config.js";
import { HTTPError } from "../lib/error.js";
import { logger } from "../lib/logger.js";
import { state } from "../lib/state.js";

interface CopilotTokenResponse {
  expires_at: number;
  refresh_in: number;
  token: string;
}

async function getCopilotToken(): Promise<CopilotTokenResponse> {
  const response = await fetch(
    `${GITHUB_API_BASE_URL}/copilot_internal/v2/token`,
    {
      headers: githubHeaders(state),
    }
  );

  if (!response.ok) {
    throw new HTTPError("Failed to get Copilot token", response);
  }

  return (await response.json()) as CopilotTokenResponse;
}

export async function setupCopilotToken(): Promise<void> {
  const { token, refresh_in } = await getCopilotToken();
  state.copilotToken = token;
  logger.info("Copilot token fetched successfully");

  // Refresh before expiry
  const refreshInterval = (refresh_in - 60) * 1000;
  setInterval(async () => {
    logger.debug("Refreshing Copilot token...");
    try {
      const { token: newToken } = await getCopilotToken();
      state.copilotToken = newToken;
      logger.debug("Copilot token refreshed");
    } catch (error) {
      logger.error("Failed to refresh Copilot token:", error);
    }
  }, refreshInterval);
}
