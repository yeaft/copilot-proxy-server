import { CryptoProvider, type AuthenticationResult, type PublicClientApplication } from "@azure/msal-node";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { authorizationError, LokiAuthError } from "./loki-errors.js";

export async function openBrowser(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "login.microsoftonline.com" || parsed.username || parsed.password) {
    throw new LokiAuthError("Refusing to open an untrusted sign-in URL.");
  }
  const command = process.platform === "win32" ? "rundll32.exe"
    : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  await new Promise<void>((resolve, reject) => {
    // No shell interpolation, even on Windows.
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    const failure = () => reject(new LokiAuthError(
      "Could not open a browser. Use npm run auth:loki -- --device-code on a device with no browser.",
    ));
    child.once("error", failure);
    child.once("exit", (code) => { if (code === 0) resolve(); else failure(); });
  });
}

/** A short-lived loopback OAuth callback, never a gateway or background service. */
export async function browserSignIn(
  client: PublicClientApplication, requested: string[], notify: (message: string) => void,
  launch: (url: string) => Promise<void> = openBrowser,
): Promise<AuthenticationResult> {
  const state = randomBytes(32).toString("hex");
  const { verifier, challenge } = await new CryptoProvider().generatePkceCodes();
  let accept!: (code: string) => void;
  let refuse!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => { accept = resolve; refuse = reject; });
  // A callback or timeout can occur before the launcher resolves.
  void code.catch(() => {});
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", "default-src 'none'");
    let url: URL;
    try { url = new URL(request.url || "/", "http://localhost"); }
    catch { response.writeHead(400).end("Invalid sign-in callback."); return; }
    const returnedState = url.searchParams.get("state") || "";
    if (request.method !== "GET" || url.pathname !== "/" || Buffer.byteLength(returnedState) !== Buffer.byteLength(state)
      || !timingSafeEqual(Buffer.from(returnedState), Buffer.from(state))) {
      response.writeHead(400).end("Invalid sign-in callback.");
      return;
    }
    const authorizationCode = url.searchParams.get("code");
    if (authorizationCode && !url.searchParams.has("error")) {
      response.end("Sign-in received. You may close this tab.");
      accept(authorizationCode);
    } else {
      response.writeHead(400).end("Sign-in was not completed. See your terminal.");
      refuse(authorizationError(url.searchParams));
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  server.on("error", () => refuse(new LokiAuthError("The sign-in callback failed.")));
  const timer = setTimeout(() => refuse(new LokiAuthError("Sign-in timed out after five minutes.")), 300_000);
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new LokiAuthError("No authentication callback port.");
    const redirectUri = `http://localhost:${address.port}`;
    const url = await client.getAuthCodeUrl({
      scopes: requested, redirectUri, state, nonce: randomBytes(32).toString("hex"),
      codeChallenge: challenge, codeChallengeMethod: "S256", prompt: "select_account",
    });
    notify("Opening your browser for work account sign-in...");
    // The timeout must also cover a hung OS launcher, not just the callback.
    const launchFailure = launch(url).then(() => new Promise<never>(() => {}));
    const authorizationCode = await Promise.race([code, launchFailure]);
    return await client.acquireTokenByCode({ code: authorizationCode, codeVerifier: verifier, redirectUri, scopes: requested });
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
