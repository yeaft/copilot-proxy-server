import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { LokiNetworkClient } from "../src/auth/loki-network.js";
import { LokiAuthentication } from "../src/auth/loki-auth.js";

// Real MSAL parsing, account/RT lookup, discovery and POST dispatch; transport is
// replaced below the network client, never contacting an identity service.
for (const phase of ["headers", "body"]) {
  test(`real MSAL silent refresh exits after hanging ${phase}, preserves disk, then retries`, { timeout: 10000 }, async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "proxy-loki-msal-test-"));
    const clientId = "aebc6443-996d-45c2-90f0-388ff96faa56";
    const environment = "login.microsoftonline.com";
    const scope = "42c8f7bd-c7a8-4ba9-bc1c-91edfb716247/.default";
    try {
      await mkdir(join(directory, "auth"));
      const cache = JSON.stringify({
        Account: { [`user.tenant-${environment}-tenant`]: {
          home_account_id: "user.tenant", environment, realm: "tenant", local_account_id: "user",
          username: "private-user@example.invalid", authority_type: "MSSTS",
        } },
        RefreshToken: { [`user.tenant-${environment}-refreshtoken-${clientId}--`]: {
          home_account_id: "user.tenant", environment, credential_type: "RefreshToken", client_id: clientId,
          secret: "offline-private-refresh-token",
        } },
      });
      const path = join(directory, "auth", "cache.json");
      const before = JSON.stringify({ accountId: "user.tenant", cache });
      await writeFile(path, before);
      let hang = true;
      let tokenPosts = 0;
      let aborted = false;
      const transport: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        assert.equal(url.origin, "https://login.microsoftonline.com");
        if (url.pathname.endsWith("/token")) {
          tokenPosts++;
          assert.equal(init?.method, "POST");
          assert.match(String(init?.body), /grant_type=refresh_token/);
          assert.match(String(init?.body), /offline-private-refresh-token/);
          const signal = init!.signal!;
          if (hang) {
            if (phase === "headers") return new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => { aborted = true; reject(new Error("offline-private-secret")); }, { once: true });
            });
            return new Response(new ReadableStream({ start(controller) {
              controller.enqueue(new TextEncoder().encode('{"access_token":"offline-private-secret'));
              signal.addEventListener("abort", () => { aborted = true; controller.error(new Error("offline-private-secret")); }, { once: true });
            } }));
          }
          return Response.json({
            token_type: "Bearer", scope, expires_in: 3600, ext_expires_in: 3600,
            access_token: "offline-access-token", refresh_token: "offline-rotated-token",
          });
        }
        if (url.pathname.includes("openid-configuration")) return Response.json({
          authorization_endpoint: `https://${environment}/organizations/oauth2/v2.0/authorize`,
          token_endpoint: `https://${environment}/organizations/oauth2/v2.0/token`,
          end_session_endpoint: `https://${environment}/organizations/oauth2/v2.0/logout`,
          issuer: `https://${environment}/tenant/v2.0`, jwks_uri: `https://${environment}/common/discovery/v2.0/keys`,
        });
        return Response.json({ tenant_discovery_endpoint: `https://${environment}/organizations/v2.0/.well-known/openid-configuration`,
          metadata: [{ preferred_network: environment, preferred_cache: environment, aliases: [environment] }] });
      };
      const network = new LokiNetworkClient(100, transport);
      context.mock.method(LokiNetworkClient.prototype, "sendGetRequestAsync", async (url, options, timeout) =>
        // Call via the unmocked implementation to exercise abort and parsing.
        originalGet.call(network, url, options, timeout));
      context.mock.method(LokiNetworkClient.prototype, "sendPostRequestAsync", async (url, options) => originalPost.call(network, url, options));
      const auth = new LokiAuthentication(directory);
      await assert.rejects(auth.getToken(), (error: Error) => {
        assert.doesNotMatch(error.message, /offline-private|private-user|example.invalid/);
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(tokenPosts, 1, "real MSAL reached the refresh POST");
      assert.equal(aborted, true);
      assert.equal(await readFile(path, "utf8"), before);
      assert.deepEqual(await readdir(join(directory, "auth")), ["cache.json"]);
      hang = false;
      assert.equal(await auth.getToken(), "offline-access-token");
      assert.equal(tokenPosts, 2);
      assert.match(await readFile(path, "utf8"), /offline-rotated-token/);
      assert.deepEqual(await readdir(join(directory, "auth")), ["cache.json"]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
const originalGet = LokiNetworkClient.prototype.sendGetRequestAsync;
const originalPost = LokiNetworkClient.prototype.sendPostRequestAsync;
