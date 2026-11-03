import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PublicClientApplication } from "@azure/msal-node";
import { LokiNetworkClient } from "../src/auth/loki-network.js";
import { LokiAuthentication, LokiAuthError } from "../src/auth/loki-auth.js";

const identity = "https://login.microsoftonline.com";
const secret = "private-token private-user@example.invalid";

async function localTransport(action: (transport: typeof fetch, closed: () => Promise<void>, hits: () => number) => Promise<void>): Promise<void> {
  const closures: Promise<void>[] = [];
  let hits = 0;
  const server = createServer((request, response) => {
    closures.push(once(request.socket, "close").then(() => {}));
    hits++;
    switch (request.url) {
      case "/hang-headers": return;
      case "/hang-body":
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"private-token":"');
        return;
      case "/redirect":
        response.writeHead(302, { location: `/ok?${secret}` });
        response.end();
        return;
      case "/large-header":
        response.writeHead(200, { "content-length": 1024 * 1024 + 1 });
        response.flushHeaders();
        return;
      case "/large-chunk":
        response.writeHead(200);
        response.end("x".repeat(1024 * 1024 + 1));
        return;
      case "/secret":
        response.end(secret);
        return;
      default:
        response.setHeader("content-type", "application/json");
        response.setHeader("x-ms-request-id", "offline-request");
        response.end('{"ok":true}');
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const transport: typeof fetch = (input, init) => {
    const target = new URL(String(input));
    assert.equal(target.origin, identity);
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    const headers = new Headers(init?.headers);
    headers.set("connection", "close");
    return fetch(`http://127.0.0.1:${address.port}${target.pathname}`, { ...init, headers });
  };
  try { await action(transport, () => Promise.all([...closures]).then(() => {}), () => hits); }
  finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

for (const method of ["GET", "POST"] as const) {
  for (const phase of ["headers", "body"]) {
    test(`${method} deadline aborts hanging ${phase}, closes its connection, and permits retry`, { timeout: 5000 }, async () => {
      await localTransport(async (transport, closed) => {
        const client = new LokiNetworkClient(180, transport);
        const request = (path: string) => method === "GET"
          ? client.sendGetRequestAsync(`${identity}${path}`)
          : client.sendPostRequestAsync(`${identity}${path}`, { body: secret });
        await assert.rejects(request(`/hang-${phase}`), (error: Error) => {
          assert.ok(error instanceof LokiAuthError);
          assert.match(error.message, /timed out/);
          assert.doesNotMatch(error.message, /private-token|example.invalid/);
          assert.equal(error.cause, undefined);
          return true;
        });
        // Observe actual socket closure, not just Promise.race rejection.
        await closed();
        const response = await request("/ok");
        assert.equal(response.status, 200);
        assert.equal(response.headers["x-ms-request-id"], "offline-request");
        assert.deepEqual(response.body, { ok: true });
      });
    });
  }
}

test("network client supports caller cancellation across headers and body without exposing abort reasons", { timeout: 5000 }, async () => {
  await localTransport(async (transport, closed) => {
    const client = new LokiNetworkClient(1000, transport);
    for (const path of ["/hang-headers", "/hang-body"]) {
      const controller = new AbortController();
      const request = client.sendPostRequestAsync(identity + path, { signal: controller.signal, body: secret });
      const timer = setTimeout(() => controller.abort(new Error(secret)), 100);
      try {
        await assert.rejects(request, (error: Error) => {
          assert.match(error.message, /cancelled/);
          assert.doesNotMatch(error.message, /private-token|example.invalid/);
          assert.equal(error.cause, undefined);
          return true;
        });
      } finally { clearTimeout(timer); }
      await closed();
    }
    assert.deepEqual((await client.sendGetRequestAsync(identity + "/ok")).body, { ok: true });
  });
});

test("identity URLs/authority are fixed; redirects, oversized and invalid bodies fail redacted", { timeout: 5000 }, async () => {
  await localTransport(async (transport, closed, hits) => {
    const client = new LokiNetworkClient(1000, transport);
    for (const url of [
      "http://login.microsoftonline.com/token", "https://evil.invalid/token",
      "https://login.microsoftonline.com.evil.invalid/token", "https://login.microsoftonline.com:444/token",
      "https://private-token@login.microsoftonline.com/token", identity + "/token#private-token", "not-a-url",
    ]) {
      await assert.rejects(client.sendPostRequestAsync(url, { body: secret }), LokiAuthError);
    }
    await assert.rejects(client.sendPostRequestAsync(identity, { headers: { Host: "evil.invalid" } }), LokiAuthError);
    assert.equal(hits(), 0);
    for (const path of ["/redirect", "/large-header", "/large-chunk", "/secret"]) {
      const before = hits();
      await assert.rejects(client.sendPostRequestAsync(identity + path, { body: secret }), (error: Error) => {
        assert.ok(error instanceof LokiAuthError);
        assert.doesNotMatch(error.message, /private-token|example.invalid|SyntaxError/);
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(hits(), before + 1, "redirect must not send a second request");
    }
    // The oversized body connection is actually cancelled rather than drained indefinitely.
    await closed();
    assert.deepEqual((await client.sendGetRequestAsync(identity + "/ok")).body, { ok: true });
  });
});

test("non-broker authentication config uses bounded transport; timeout releases cache lock/pending and allows retry", { timeout: 10000 }, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "proxy-loki-network-test-"));
  try {
    const authDirectory = join(directory, "auth");
    await mkdir(authDirectory);
    const path = join(authDirectory, "cache.json");
    const cache = JSON.stringify({ Account: { "user-tenant": {
      home_account_id: "user.tenant", environment: "login.microsoftonline.com", realm: "tenant",
      local_account_id: "user", username: "user@example.invalid", authority_type: "MSSTS",
    } } });
    const stored = JSON.stringify({ accountId: "user.tenant", cache });
    await writeFile(path, stored);
    await localTransport(async (transport, closed) => {
      let hang = true;
      const network = new LokiNetworkClient(180, transport);
      context.mock.method(LokiNetworkClient.prototype, "sendPostRequestAsync", async () => {
        return network.sendGetRequestAsync(identity + (hang ? "/hang-body" : "/ok"));
      });
      context.mock.method(PublicClientApplication.prototype, "acquireTokenSilent", async function (this: PublicClientApplication) {
        // Exercise the configured client, rather than a transport unused by MSAL.
        const configured = (this as unknown as { config: { system: { networkClient: LokiNetworkClient } } }).config.system.networkClient;
        assert.ok(configured instanceof LokiNetworkClient);
        await configured.sendPostRequestAsync(identity + "/token", { body: secret });
        return { accessToken: "offline-token", expiresOn: new Date(Date.now() + 3_600_000) };
      });
      const auth = new LokiAuthentication(directory);
      const requests = Array.from({ length: 5 }, () => auth.getToken());
      for (const response of await Promise.allSettled(requests)) {
        assert.equal(response.status, "rejected");
        if (response.status === "rejected") {
          assert.ok(response.reason instanceof LokiAuthError);
          assert.doesNotMatch(response.reason.message, /private-token|example.invalid/);
        }
      }
      await closed();
      assert.equal(await readFile(path, "utf8"), stored);
      assert.deepEqual(await readdir(authDirectory), ["cache.json"]);
      assert.equal((await auth.account())?.homeAccountId, "user.tenant", "lock released after timeout");
      hang = false;
      assert.equal(await auth.getToken(), "offline-token", "pending cleared after timeout");
      assert.equal(await readFile(path, "utf8"), stored);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
