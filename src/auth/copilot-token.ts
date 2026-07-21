import { GITHUB_API_BASE_URL, githubHeaders, copilotHeaders } from "./api-config.js";
import { HTTPError } from "../lib/error.js";
import { logger } from "../lib/logger.js";
import { state } from "../lib/state.js";

interface CopilotTokenResponse {
  expires_at: number;
  refresh_in: number;
  token: string;
}

const MAX_TOKEN_ATTEMPTS = 4;
const INITIAL_RETRY_DELAY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1_000;
    }
  }

  return INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1);
}

async function getCopilotToken(): Promise<CopilotTokenResponse> {
  for (let attempt = 1; attempt <= MAX_TOKEN_ATTEMPTS; attempt++) {
    const response = await fetch(
      `${GITHUB_API_BASE_URL}/copilot_internal/v2/token`,
      {
        headers: githubHeaders(state),
      }
    );

    if (response.ok) {
      return (await response.json()) as CopilotTokenResponse;
    }

    if (!isRetryableStatus(response.status) || attempt === MAX_TOKEN_ATTEMPTS) {
      throw new HTTPError("Failed to get Copilot token", response);
    }

    const delay = retryDelay(response, attempt);
    const requestId = response.headers.get("x-github-request-id");
    logger.warn(
      `GitHub Copilot token request returned ${response.status}` +
        `${requestId ? ` (request ID: ${requestId})` : ""}; ` +
        `retrying in ${delay}ms (${attempt}/${MAX_TOKEN_ATTEMPTS})`
    );
    await response.body?.cancel();
    await sleep(delay);
  }

  throw new Error("Copilot token retry loop exited unexpectedly");
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
