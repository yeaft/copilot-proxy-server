import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PublicClientApplication } from "@azure/msal-node";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AccountInfo, AuthenticationResult } from "@azure/msal-node";
import { LokiAuthentication, LokiAuthError, LokiSignInRequired, type AccessToken } from "../src/auth/loki-auth.js";
import { atomicWrite, privateDirectory, withLock } from "../src/auth/loki-storage.js";
import { browserSignIn, openBrowser } from "../src/auth/loki-browser.js";

const scopes = ["42c8f7bd-c7a8-4ba9-bc1c-91edfb716247/.default"];
const account: AccountInfo = {
  homeAccountId: "test-user.test-tenant", environment: "login.microsoftonline.com",
  tenantId: "test-tenant", username: "test@example.invalid", localAccountId: "test-user",
  nativeAccountId: "test-native-user", idTokenClaims: { privateClaim: "do-not-persist" },
};
const result = {
  account, accessToken: "mock-access-token", idToken: "mock-id-token", fromPlatformBroker: true,
  expiresOn: new Date(Date.now() + 3_600_000),
} as AuthenticationResult;

async function temporary(action: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "proxy-loki-test-"));
  try { await action(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

class MockAuthentication extends LokiAuthentication {
  browserCalls: { scopes: string[]; deviceCode: boolean }[] = [];
  constructor(directory: string, private readonly broker?: PublicClientApplication) { super(directory); }
  protected override async brokerClient(): Promise<PublicClientApplication | undefined> { return this.broker; }
  protected override async interactive(requested: string[], deviceCode: boolean): Promise<AuthenticationResult> {
    this.browserCalls.push({ scopes: requested, deviceCode });
    return { ...result, fromPlatformBroker: false };
  }
}

function serializedAccountCache(): string {
  return JSON.stringify({ Account: {
    "test-user.test-tenant-login.microsoftonline.com-test-tenant": {
      home_account_id: account.homeAccountId, environment: account.environment, realm: account.tenantId,
      local_account_id: account.localAccountId, username: account.username, authority_type: "MSSTS",
    },
  } });
}

function mockBroker(overrides: object = {}): PublicClientApplication {
  return {
    acquireTokenInteractive: async () => result,
    acquireTokenSilent: async () => ({ ...result, accessToken: "mock-refreshed-token" }),
    ...overrides,
  } as unknown as PublicClientApplication;
}

test("missing credentials require explicit sign-in without contacting Microsoft", async () => temporary(async (directory) => {
  const auth = new LokiAuthentication(directory);
  assert.equal(await auth.account(), undefined);
  await assert.rejects(auth.getToken(), (error: Error) => {
    assert.ok(error instanceof LokiSignInRequired);
    assert.match(error.message, /npm run auth:loki|--loki-auth/);
    return true;
  });
  assert.deepEqual(await readdir(join(directory, "auth")), []);
}));

test("invalid caches are not overwritten and never expose their contents or path", async () => temporary(async (directory) => {
  await mkdir(join(directory, "auth"));
  const path = join(directory, "auth", "cache.json");
  for (const text of [
    '{"private-token": secret', "null", "[]", '{"cache":"null","accountId":"user"}',
    '{"cache":"[]","accountId":"user"}', '{"cache":"{}","accountId":3}',
    '{"cache":"{\\"Account\\":3}","accountId":"user"}',
    '{"cache":"{}","accountId":"user","brokerAccount":{"nativeAccountId":"secret"}}',
  ]) {
    await writeFile(path, text);
    await assert.rejects(new LokiAuthentication(directory).getToken(), (error: Error) => {
      assert.ok(error instanceof LokiSignInRequired);
      assert.match(error.message, /Invalid credential cache/);
      assert.doesNotMatch(error.message, /private-token|secret|proxy-loki-test-/);
      return true;
    });
    assert.equal(await readFile(path, "utf8"), text);
  }
}));

test("broker sign-in persists identifiers only, survives restart, and forces a 401 refresh", async () => temporary(async (directory) => {
  const refreshes: { account: AccountInfo; forceRefresh: boolean }[] = [];
  const broker = mockBroker({
    acquireTokenInteractive: async (request: { scopes: string[]; prompt: string }) => {
      assert.deepEqual(request.scopes, scopes);
      assert.equal(request.prompt, "select_account");
      return result;
    },
    acquireTokenSilent: async (request: { account: AccountInfo; forceRefresh: boolean }) => {
      refreshes.push(request);
      return { ...result, accessToken: `mock-refreshed-${refreshes.length}` };
    },
  });
  const auth = new MockAuthentication(directory, broker);
  const messages: string[] = [];
  await auth.signIn(false, (message) => messages.push(message));
  assert.equal(await auth.getToken(), result.accessToken);
  assert.equal(refreshes.length, 0);
  assert.equal(auth.browserCalls.length, 0);
  assert.match(messages.join("\n"), /Opening Windows sign-in/);
  const stored = await readFile(join(directory, "auth", "cache.json"), "utf8");
  assert.doesNotMatch(stored, /mock-access-token|mock-id-token|privateClaim|do-not-persist/);
  const restarted = new MockAuthentication(directory, broker);
  assert.equal((await restarted.account())?.nativeAccountId, account.nativeAccountId);
  assert.equal(await restarted.getToken(), "mock-refreshed-1");
  // Upstream's 401 retry uses this explicit forced-refresh contract.
  assert.equal(await restarted.getToken(true), "mock-refreshed-2");
  assert.deepEqual(refreshes.map((request) => request.forceRefresh), [false, true]);
  assert.equal(refreshes[0].account.homeAccountId, account.homeAccountId);
  assert.doesNotMatch(messages.join("\n"), /mock-access-token|mock-id-token/);
}));

test("a persisted broker account never silently falls back when the broker is unavailable", async () => temporary(async (directory) => {
  await new MockAuthentication(directory, mockBroker()).signIn(false, () => {});
  const auth = new MockAuthentication(directory);
  assert.equal((await auth.account())?.homeAccountId, account.homeAccountId);
  await assert.rejects(auth.getToken(), (error: Error) => error instanceof LokiSignInRequired && /broker is unavailable/.test(error.message));
  assert.equal(auth.browserCalls.length, 0);
}));

test("browser fallback and explicit device code request the Loki scopes once", async () => temporary(async (directory) => {
  for (const deviceCode of [false, true]) {
    const auth = new MockAuthentication(join(directory, String(deviceCode)), deviceCode ? mockBroker({
      acquireTokenInteractive: async () => { throw new Error("must not invoke broker"); },
    }) : undefined);
    await auth.signIn(deviceCode, () => {});
    assert.deepEqual(auth.browserCalls, [{ scopes, deviceCode }]);
    const stored = JSON.parse(await readFile(join(directory, String(deviceCode), "auth", "cache.json"), "utf8"));
    assert.equal(stored.brokerAccount, undefined);
  }
}));

test("broker failure preserves the previous sign-in, redacts diagnostics, and does not retry in browser", async () => temporary(async (directory) => {
  await new MockAuthentication(directory, mockBroker()).signIn(false, () => {});
  const path = join(directory, "auth", "cache.json");
  const before = await readFile(path, "utf8");
  const auth = new MockAuthentication(directory, mockBroker({
    acquireTokenInteractive: async () => {
      throw Object.assign(new Error("AADSTS530084 private-token test@example.invalid"), { errorCode: "platform_broker_error" });
    },
  }));
  await assert.rejects(auth.signIn(false, () => {}), (error: Error) => {
    assert.ok(error instanceof LokiAuthError);
    assert.match(error.message, /platform_broker_error, AADSTS530084/);
    assert.doesNotMatch(error.message, /private-token|example.invalid/);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(auth.browserCalls.length, 0);
  assert.equal(await readFile(path, "utf8"), before);
}));

test("a broker that disappears during interactive sign-in fails closed", async () => temporary(async (directory) => {
  const auth = new MockAuthentication(directory, mockBroker({
    acquireTokenInteractive: async (request: { openBrowser: () => Promise<void> }) => { await request.openBrowser(); },
  }));
  await assert.rejects(auth.signIn(false, () => {}), /broker became unavailable/);
  assert.deepEqual(auth.browserCalls, []);
}));

test("broker interaction-required errors are recognized across duplicated MSAL classes; network failures are retryable", async () => temporary(async (directory) => {
  await new MockAuthentication(directory, mockBroker()).signIn(false, () => {});
  for (const code of ["interaction_required", "consent_required", "login_required", "no_account_found", "network_error", "PRIVATE_TOKEN_ABC123"]) {
    const auth = new MockAuthentication(directory, mockBroker({
      acquireTokenSilent: async () => { throw Object.assign(new Error("private-token private-account"), { errorCode: code }); },
    }));
    await assert.rejects(auth.getToken(), (error: Error) => {
      assert.ok(error instanceof LokiAuthError);
      assert.equal(error instanceof LokiSignInRequired, !["network_error", "PRIVATE_TOKEN_ABC123"].includes(code));
      assert.doesNotMatch(error.message, /private-token|private-account|PRIVATE_TOKEN_ABC123/);
      return true;
    });
  }
}));

class CountingAuthentication extends LokiAuthentication {
  calls: boolean[] = [];
  lifetime = 3_600_000;
  failNext = false;
  protected override async acquire(forceRefresh: boolean): Promise<AccessToken> {
    this.calls.push(forceRefresh);
    const number = this.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 15));
    if (this.failNext) { this.failNext = false; throw new Error("private refresh diagnostics"); }
    return { value: `mock-token-${number}`, expiresAt: Date.now() + this.lifetime };
  }
}

test("memory tokens respect the five-minute margin and merge normal and forced concurrent refreshes", async () => {
  const auth = new CountingAuthentication("unused-mock-only");
  assert.deepEqual(await Promise.all(Array.from({ length: 10 }, () => auth.getToken())), Array(10).fill("mock-token-1"));
  assert.equal(await auth.getToken(), "mock-token-1");
  assert.deepEqual(await Promise.all(Array.from({ length: 10 }, () => auth.getToken(true))), Array(10).fill("mock-token-2"));
  assert.deepEqual(auth.calls, [false, true]);
  auth.lifetime = 60_000;
  await auth.getToken(true);
  assert.equal(await auth.getToken(), "mock-token-4");
  auth.lifetime = 3_600_000;
  auth.failNext = true;
  await assert.rejects(auth.getToken(true), LokiAuthError);
  assert.equal(await auth.getToken(), "mock-token-6", "failed refresh must evict the previous token");
});

test("a 401 refresh queued behind a normal acquisition never reuses the unforced result", async () => {
  const auth = new CountingAuthentication("unused-mock-only");
  const normal = auth.getToken();
  const forced = Array.from({ length: 10 }, () => auth.getToken(true));
  assert.equal(await normal, "mock-token-1");
  assert.deepEqual(await Promise.all(forced), Array(10).fill("mock-token-2"));
  assert.deepEqual(auth.calls, [false, true]);
  assert.equal(await auth.getToken(), "mock-token-2");
});

test("storage replaces files atomically, enforces private POSIX modes, and serializes independent lock holders", async () => temporary(async (directory) => {
  await privateDirectory(directory);
  const path = join(directory, "value");
  await atomicWrite(path, "initial");
  await Promise.all(Array.from({ length: 5 }, () => withLock(directory, "test", async () => {
    const text = await readFile(path, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await atomicWrite(path, text + "!");
  })));
  assert.equal(await readFile(path, "utf8"), "initial!!!!!");
  assert.deepEqual(await readdir(directory), ["value"]);
  if (process.platform !== "win32") {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
}));

test("non-broker MSAL cache round-trips, persists refresh updates, and clears memory when removed", async (context) => temporary(async (directory) => {
  const path = join(directory, "auth", "cache.json");
  await mkdir(join(directory, "auth"));
  await writeFile(path, JSON.stringify({ accountId: account.homeAccountId, cache: serializedAccountCache() }));
  const auth = new LokiAuthentication(directory);
  assert.equal((await auth.account())?.homeAccountId, account.homeAccountId);
  let calls = 0;
  context.mock.method(PublicClientApplication.prototype, "acquireTokenSilent", async function (this: PublicClientApplication, request: { account: AccountInfo; forceRefresh: boolean }) {
    calls++;
    assert.equal(request.account.homeAccountId, account.homeAccountId);
    assert.equal(request.forceRefresh, calls === 2);
    // Simulate MSAL updating refresh credentials; the real serializer is exercised.
    this.getTokenCache().deserialize(serializedAccountCache().replace("test@example.invalid", "updated@example.invalid"));
    return { ...result, accessToken: `mock-silent-${calls}`, fromPlatformBroker: false };
  });
  assert.equal(await auth.getToken(), "mock-silent-1");
  assert.equal(await auth.getToken(true), "mock-silent-2");
  assert.match(await readFile(path, "utf8"), /updated@example.invalid/);
  assert.equal((await new LokiAuthentication(directory).account())?.homeAccountId, account.homeAccountId);
  await rm(path);
  assert.equal(await auth.account(), undefined);
  await assert.rejects(auth.getToken(true), LokiSignInRequired);
  assert.equal(calls, 2);
}));

test("explicit device-code uses the MSAL device API, bypasses the broker and never emits arbitrary messages", async (context) => temporary(async (directory) => {
  context.mock.method(PublicClientApplication.prototype, "acquireTokenByDeviceCode", async function (this: PublicClientApplication, request: {
    scopes: string[]; timeout: number; deviceCodeCallback: (value: object) => void;
  }) {
    assert.deepEqual(request.scopes, scopes);
    assert.equal(request.timeout, 300);
    request.deviceCodeCallback({
      verificationUri: "https://microsoft.com/devicelogin", userCode: "TEST-CODE",
      message: "private-token private-account",
    });
    this.getTokenCache().deserialize(serializedAccountCache());
    return { ...result, fromPlatformBroker: false };
  });
  const messages: string[] = [];
  const auth = new LokiAuthentication(directory);
  await auth.signIn(true, (message) => messages.push(message));
  assert.match(messages.join("\n"), /https:\/\/microsoft.com\/devicelogin.*TEST-CODE/);
  assert.doesNotMatch(messages.join("\n"), /private-token|private-account|mock-access-token/);
  assert.equal(await auth.getToken(), result.accessToken);
  assert.equal((await new LokiAuthentication(directory).account())?.homeAccountId, account.homeAccountId);
}));

test("MSAL device errors and unexpected cache filesystem errors cross only a redacted boundary", async (context) => temporary(async (directory) => {
  context.mock.method(PublicClientApplication.prototype, "acquireTokenByDeviceCode", async () => {
    throw new Error("private-token private-user AADSTS530084");
  });
  await assert.rejects(new LokiAuthentication(directory).signIn(true, () => {}), (error: Error) => {
    assert.ok(error instanceof LokiAuthError);
    assert.match(error.message, /AADSTS530084/);
    assert.doesNotMatch(error.message, /private-token|private-user/);
    return true;
  });
  await mkdir(join(directory, "auth", "cache.json"));
  await assert.rejects(new LokiAuthentication(directory).account(), (error: Error) => {
    assert.ok(error instanceof LokiSignInRequired);
    assert.doesNotMatch(error.message, /proxy-loki-test-|EISDIR/);
    return true;
  });
}));

test("broker results must be genuine broker accounts before any credentials are persisted", async () => temporary(async (directory) => {
  for (const granted of [
    { ...result, fromPlatformBroker: false },
    { ...result, account: { ...account, nativeAccountId: "" } },
  ]) {
    const auth = new MockAuthentication(directory, mockBroker({ acquireTokenInteractive: async () => granted }));
    await assert.rejects(auth.signIn(false, () => {}), /did not return a broker account/);
    assert.deepEqual(await readdir(join(directory, "auth")), []);
    assert.equal(auth.browserCalls.length, 0);
  }
}));

test("independent processes serialize cache updates without a daemon", async () => temporary(async (directory) => {
  await privateDirectory(directory);
  const path = join(directory, "value");
  await atomicWrite(path, "start");
  const moduleUrl = new URL("../src/auth/loki-storage.ts", import.meta.url).href;
  const code = `
    import { readFile } from 'node:fs/promises';
    import { withLock, atomicWrite } from ${JSON.stringify(moduleUrl)};
    await withLock(${JSON.stringify(directory)}, 'process-test', async () => {
      const value = await readFile(${JSON.stringify(path)}, 'utf8');
      await new Promise(resolve => setTimeout(resolve, 40));
      await atomicWrite(${JSON.stringify(path)}, value + '!');
    });
  `;
  await Promise.all(Array.from({ length: 3 }, () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", "ignore", "pipe"],
    });
    let diagnostics = "";
    child.stderr.on("data", (chunk) => { diagnostics += chunk; });
    child.once("error", reject);
    child.once("exit", (status) => status === 0 ? resolve() : reject(new Error(diagnostics)));
  })));
  assert.equal(await readFile(path, "utf8"), "start!!!");
}));

test("browser PKCE loopback validates state and closes its temporary listener", async () => {
  let callback = "";
  let challenge = "";
  let returnedState = "";
  const client = {
    getAuthCodeUrl: async (request: { redirectUri: string; state: string; codeChallenge: string; codeChallengeMethod: string }) => {
      callback = request.redirectUri;
      returnedState = request.state;
      challenge = request.codeChallenge;
      assert.equal(request.codeChallengeMethod, "S256");
      assert.ok(challenge.length > 30);
      return "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize";
    },
    acquireTokenByCode: async (request: { code: string; codeVerifier: string; redirectUri: string }) => {
      assert.equal(request.code, "mock-authorization-code");
      assert.ok(request.codeVerifier.length > 30);
      assert.notEqual(request.codeVerifier, challenge);
      assert.equal(request.redirectUri, callback);
      return result;
    },
  } as unknown as PublicClientApplication;
  const granted = await browserSignIn(client, scopes, () => {}, async () => {
    const local = callback.replace("localhost", "127.0.0.1");
    const bad = await fetch(`${local}/?state=bad&code=stolen-code`);
    assert.equal(bad.status, 400);
    await bad.text();
    const good = await fetch(`${local}/?state=${returnedState}&code=mock-authorization-code`);
    assert.equal(good.status, 200);
    assert.equal(good.headers.get("cache-control"), "no-store");
    await good.text();
  });
  assert.equal(granted, result);
  await assert.rejects(fetch(callback.replace("localhost", "127.0.0.1")));
});

test("browser callback policy errors are redacted; untrusted launcher URLs never spawn a browser", async () => {
  let callback = "";
  let state = "";
  const client = {
    getAuthCodeUrl: async (request: { redirectUri: string; state: string }) => {
      callback = request.redirectUri;
      state = request.state;
      return "https://login.microsoftonline.com/authorize";
    },
  } as unknown as PublicClientApplication;
  await assert.rejects(browserSignIn(client, scopes, () => {}, async () => {
    const response = await fetch(callback.replace("localhost", "127.0.0.1") + "/?" + new URLSearchParams({
      state, error: "access_denied", error_description: "AADSTS530084 private-user private-token",
    }));
    await response.text();
  }), (error: Error) => {
    assert.ok(error instanceof LokiAuthError);
    assert.match(error.message, /access_denied, AADSTS530084/);
    assert.doesNotMatch(error.message, /private-user|private-token/);
    return true;
  });
  for (const url of ["http://login.microsoftonline.com/", "https://evil.invalid/", "https://secret@login.microsoftonline.com/"]) {
    await assert.rejects(openBrowser(url), /untrusted sign-in URL/);
  }
});

test("explicit sign-in repairs malformed JSON only after successful authentication", async () => temporary(async (directory) => {
  await mkdir(join(directory, "auth"));
  const path = join(directory, "auth", "cache.json");
  const corrupt = '{"private-token":broken';
  await writeFile(path, corrupt);
  const failing = new MockAuthentication(directory, mockBroker({
    acquireTokenInteractive: async () => { throw new Error("mock authentication failed"); },
  }));
  await assert.rejects(failing.signIn(false, () => {}), LokiAuthError);
  assert.equal(await readFile(path, "utf8"), corrupt);
  await new MockAuthentication(directory, mockBroker()).signIn(false, () => {});
  assert.equal((await new MockAuthentication(directory).account())?.homeAccountId, account.homeAccountId);
}));
