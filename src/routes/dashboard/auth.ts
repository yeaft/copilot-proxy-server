import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { getCookie, setCookie } from "hono/cookie";

const COOKIE_NAME = "dashboard_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer);
}

function sessionSecret(username: string, password: string): string {
  return createHmac("sha256", password)
    .update(`copilot-proxy-dashboard:${username}`)
    .digest("base64url");
}

function createSession(username: string, password: string, now = Date.now()): string {
  const expiresAt = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  const payload = `${username}.${expiresAt}`;
  const signature = createHmac("sha256", sessionSecret(username, password))
    .update(payload)
    .digest("base64url");
  return Buffer.from(`${payload}.${signature}`).toString("base64url");
}

function isValidSession(
  token: string | undefined,
  username: string,
  password: string,
  now = Date.now()
): boolean {
  if (!token) return false;
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const separator = decoded.lastIndexOf(".");
    if (separator < 0) return false;
    const payload = decoded.slice(0, separator);
    const signature = decoded.slice(separator + 1);
    const payloadSeparator = payload.lastIndexOf(".");
    if (payloadSeparator < 0) return false;
    const tokenUsername = payload.slice(0, payloadSeparator);
    const expiresAt = Number(payload.slice(payloadSeparator + 1));
    if (tokenUsername !== username || !Number.isFinite(expiresAt)) return false;
    if (expiresAt < Math.floor(now / 1000)) return false;

    const expected = createHmac("sha256", sessionSecret(username, password))
      .update(payload)
      .digest("base64url");
    return safeEqual(signature, expected);
  } catch {
    return false;
  }
}

function loginPage(error = false): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dashboard Login</title><style>body{margin:0;background:#0f172a;color:#e2e8f0;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}.card{width:min(360px,calc(100vw - 48px));background:#1e293b;border:1px solid #334155;border-radius:16px;padding:32px}h1{font-size:24px;margin:0 0 24px}label{display:block;color:#94a3b8;font-size:13px;margin:14px 0 6px}input{box-sizing:border-box;width:100%;padding:11px 12px;border-radius:8px;border:1px solid #475569;background:#0f172a;color:#f8fafc}button{width:100%;margin-top:22px;padding:11px;border:0;border-radius:8px;background:#2563eb;color:white;font-weight:600;cursor:pointer}.error{color:#fca5a5;font-size:13px}</style></head><body><form class="card" method="post" action="/dashboard/login"><h1>Dashboard Login</h1>${error ? '<p class="error">Invalid username or password.</p>' : ''}<label for="username">Username</label><input id="username" name="username" autocomplete="username" required autofocus><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">Sign in</button></form></body></html>`;
}

export function createDashboardAuth(username: string, password: string) {
  return {
    loginPage,
    async login(c: Context) {
      const body = await c.req.parseBody();
      const providedUser = typeof body.username === "string" ? body.username : "";
      const providedPass = typeof body.password === "string" ? body.password : "";
      const validUser = safeEqual(providedUser, username);
      const validPass = safeEqual(providedPass, password);
      if (!validUser || !validPass) return c.html(loginPage(true), 401);

      const forwardedProto = c.req.header("x-forwarded-proto")?.split(",", 1)[0]?.trim();
      setCookie(c, COOKIE_NAME, createSession(username, password), {
        path: "/dashboard",
        httpOnly: true,
        sameSite: "Lax",
        secure: forwardedProto === "https" || new URL(c.req.url).protocol === "https:",
        maxAge: SESSION_TTL_SECONDS,
      });
      return c.redirect("/dashboard", 303);
    },
    middleware: async (c: Context, next: Next) => {
      if (isValidSession(getCookie(c, COOKIE_NAME), username, password)) {
        return next();
      }
      if (c.req.path.startsWith("/dashboard/api/")) {
        return c.json({ error: "Dashboard session expired." }, 401);
      }
      return c.redirect("/dashboard/login", 303);
    },
  };
}
