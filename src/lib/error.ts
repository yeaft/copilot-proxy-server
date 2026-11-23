import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { logger } from "./logger.js";

export class HTTPError extends Error {
  response: Response;

  constructor(message: string, response: Response) {
    super(message);
    this.response = response;
  }
}

export class UpstreamHeadersTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Upstream did not send response headers within ${timeoutMs / 1000} seconds.`);
    this.name = "UpstreamHeadersTimeoutError";
  }
}

export async function forwardError(c: Context, error: unknown) {
  logger.error("Error occurred:", error);

  if (error instanceof UpstreamHeadersTimeoutError) {
    return c.json(
      {
        error: {
          message: error.message,
          type: "upstream_error",
          code: "upstream_headers_timeout",
        },
      },
      504
    );
  }

  if (error instanceof HTTPError) {
    const errorText = await error.response.text();
    let errorJson: unknown;
    try {
      errorJson = JSON.parse(errorText);
    } catch {
      errorJson = errorText;
    }
    logger.error("HTTP error:", errorJson);
    return c.json(
      {
        error: {
          message: errorText,
          type: "error",
        },
      },
      error.response.status as ContentfulStatusCode
    );
  }

  return c.json(
    {
      error: {
        message: (error as Error).message,
        type: "error",
      },
    },
    500
  );
}
