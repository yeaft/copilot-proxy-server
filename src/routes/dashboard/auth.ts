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

/** Sign-in page in the dashboard's visual style. Uses only /dashboard/style.css, which is public. */
function loginPage(error = false): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Copilot Proxy · Sign in</title>
  <link rel="stylesheet" href="/dashboard/style.css">
</head>
<body>
  <main class="login-shell">
    <form class="panel login-card" method="post" action="/dashboard/login">
      <div class="brand">
        <span class="logo" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 13h3.5l2.5-6 4 11 2.5-6H21"/></svg></span>
        <span class="brand-text"><strong>Copilot Proxy</strong><span>Analytics</span></span>
      </div>
      <h1>Sign in</h1>
      ${error ? '<p class="login-error" role="alert">Invalid username or password.</p>' : ""}
      <label class="login-field">Username<input name="username" autocomplete="username" required autofocus></label>
      <label class="login-field">Password<input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit" class="primary">Sign in</button>
    </form>
  </main>
</body>
</html>`;
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
