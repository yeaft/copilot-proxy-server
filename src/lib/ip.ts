import type { Context } from "hono";

/**
 * Extract client IP from request headers or connection info.
 */
export function getClientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return c.req.header("x-real-ip") ?? "unknown";
}
