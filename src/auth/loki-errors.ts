export class LokiAuthError extends Error {
  override name = "LokiAuthError";
}

/** The stored credentials cannot produce a token without an explicit sign-in. */
export class LokiSignInRequired extends LokiAuthError {
  override name = "LokiSignInRequired";
}

export const signInHint = "Run npm run auth:loki (or --loki-auth) to sign in again.";

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function errorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}

// Do not echo arbitrary server-supplied error codes: those can contain credentials too.
const safeCodes = new Set([
  "interaction_required", "consent_required", "login_required", "no_account_found",
  "invalid_grant", "invalid_client", "access_denied", "authorization_declined",
  "authorization_pending", "expired_token", "user_cancelled", "user_canceled",
  "platform_broker_error", "broker_error", "network_error", "post_request_failed",
  "get_request_failed", "temporarily_unavailable", "server_error", "invalid_scope",
  "authentication_failed", "authorization_failed", "device_code_expired",
]);

export function authErrorDetail(error: unknown): string {
  const code = isObject(error) && typeof error.errorCode === "string" && safeCodes.has(error.errorCode)
    ? error.errorCode : "authentication_failed";
  const aad = error instanceof Error ? error.message.match(/\bAADSTS\d{5,9}\b/)?.[0] : undefined;
  return [code, aad].filter(Boolean).join(", ");
}

export function safeAuthError(error: unknown): LokiAuthError {
  return new LokiAuthError(`Sign-in failed (${authErrorDetail(error)}). ${signInHint} `
    + "Token protection requires the Windows sign-in broker; browser and device-code sign-in cannot supply broker-bound tokens.");
}

export function authorizationError(parameters: URLSearchParams): LokiAuthError {
  const description = parameters.get("error_description") || "";
  const aad = description.match(/\bAADSTS\d{5,9}\b/)?.[0]
    ?? description.match(/\b(?:Error Code|error code):?\s*(\d{5,6})\b/)?.[1];
  return safeAuthError(Object.assign(new Error(aad ? (aad.startsWith("AADSTS") ? aad : `AADSTS${aad}`) : ""), {
    errorCode: parameters.get("error") || "authorization_failed",
  }));
}

/** Drop SDK/network/filesystem diagnostics, including causes, at the public boundary. */
export function sanitizedError(error: unknown): LokiAuthError {
  return error instanceof LokiAuthError ? error : safeAuthError(error);
}
