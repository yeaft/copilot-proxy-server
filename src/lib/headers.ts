import type { Context } from "hono";

/**
 * Extract all headers from the incoming client request as a plain object.
 * The downstream `filterClientHeaders` in copilot-completions will strip
 * hop-by-hop and auth headers before forwarding to the Copilot API.
 */
export function extractClientHeaders(c: Context): Record<string, string> {
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}
