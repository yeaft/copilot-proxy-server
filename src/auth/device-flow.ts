import {
  GITHUB_APP_SCOPES,
  GITHUB_BASE_URL,
  GITHUB_CLIENT_ID,
  standardHeaders,
} from "./api-config.js";
import { logger } from "../lib/logger.js";

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export async function getDeviceCode(): Promise<DeviceCodeResponse> {
  const response = await fetch(`${GITHUB_BASE_URL}/login/device/code`, {
    method: "POST",
    headers: standardHeaders(),
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      scope: GITHUB_APP_SCOPES,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to get device code: ${response.status}`);
  }

  return (await response.json()) as DeviceCodeResponse;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollAccessToken(
  deviceCode: DeviceCodeResponse
): Promise<string> {
  const sleepDuration = (deviceCode.interval + 1) * 1000;
  logger.debug(`Polling access token with interval of ${sleepDuration}ms`);

  while (true) {
    const response = await fetch(
      `${GITHUB_BASE_URL}/login/oauth/access_token`,
      {
        method: "POST",
        headers: standardHeaders(),
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: deviceCode.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      }
    );

    if (!response.ok) {
      await sleep(sleepDuration);
      logger.error("Failed to poll access token:", await response.text());
      continue;
    }

    const json = (await response.json()) as { access_token?: string };
    logger.debug("Polling access token response:", JSON.stringify(json));

    if (json.access_token) {
      return json.access_token;
    } else {
      await sleep(sleepDuration);
    }
  }
}
