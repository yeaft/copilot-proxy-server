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
  protected override async acquireBrokerToken(selected: AccountInfo): Promise<AccessToken> {
    if (!this.broker) throw new LokiSignInRequired("The Windows sign-in broker is unavailable.");
    const granted = await this.broker.acquireTokenSilent({ account: selected, scopes, forceRefresh: false });
    return { value: granted.accessToken, expiresAt: granted.expiresOn?.getTime() ?? 0 };
  }
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
    '{"cache":"{}","accountId":"user","generation":3}',
    '{"cache":"{}","accountId":"user","generation":"invalid"}',
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

test("broker sign-in persists identifiers only, survives restart; forced refresh requires explicit sign-in", async () => temporary(async (directory) => {
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
  // Never claim that setting MSAL's forceRefresh forces the native broker.
  await assert.rejects(auth.getToken(true), /cannot guarantee a forced token refresh.*npm run auth:loki/);
  await assert.rejects(auth.getToken(), LokiSignInRequired, "a 401 evicts and quarantines the rejected broker token");
  assert.deepEqual(refreshes.map((request) => request.forceRefresh), [false]);
  assert.equal(await readFile(join(directory, "auth", "cache.json"), "utf8"), stored);
  assert.deepEqual(await readdir(join(directory, "auth")), ["cache.json"]);
  assert.doesNotMatch(messages.join("\n"), /mock-access-token|mock-id-token/);
}));

test("a persisted broker account never silently falls back to a non-broker token", async () => temporary(async (directory) => {
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

test("non-broker interaction-required errors are recognized across duplicated MSAL classes; network failures are retryable", async (context) => temporary(async (directory) => {
  await mkdir(join(directory, "auth"));
  await writeFile(join(directory, "auth", "cache.json"), JSON.stringify({ accountId: account.homeAccountId, cache: serializedAccountCache() }));
  let code = "";
  context.mock.method(PublicClientApplication.prototype, "acquireTokenSilent", async () => {
    throw Object.assign(new Error("private-token private-account"), { errorCode: code });
  });
  const auth = new LokiAuthentication(directory);
  for (code of ["interaction_required", "consent_required", "login_required", "no_account_found", "network_error", "PRIVATE_TOKEN_ABC123"]) {
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
      verificationUri: "https://login.microsoft.com/device", userCode: "ABCD123EF",
      message: "private-token private-account",
    });
    this.getTokenCache().deserialize(serializedAccountCache());
    return { ...result, fromPlatformBroker: false };
  });
  const messages: string[] = [];
  const auth = new LokiAuthentication(directory);
  await auth.signIn(true, (message) => messages.push(message));
  assert.match(messages.join("\n"), /https:\/\/login.microsoft.com\/device.*ABCD123EF/);
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

test("explicit sign-in repairs invalid cache structures and oversized files without weakening read paths", async () => temporary(async (directory) => {
  await mkdir(join(directory, "auth"));
  const path = join(directory, "auth", "cache.json");
  for (const corrupt of [
    "null", "[]", '{"cache":"null","accountId":"user"}',
    '{"cache":"{\\"Account\\":3}","accountId":"user"}',
    '{"cache":"{}","accountId":"user","brokerAccount":{"nativeAccountId":"secret"}}',
    '{"cache":"{}","accountId":"user","generation":3}',
    '{"cache":"{}","accountId":"user","generation":"invalid"}',
    "x".repeat(16 * 1024 * 1024 + 1),
  ]) {
    await writeFile(path, corrupt);
    const auth = new MockAuthentication(directory, mockBroker({
      acquireTokenInteractive: async () => {
        assert.equal(await readFile(path, "utf8"), corrupt, "sign-in must not replace the cache before authentication");
        throw new Error("mock authentication failed");
      },
    }));
    await assert.rejects(auth.account(), LokiSignInRequired);
    await assert.rejects(auth.getToken(), LokiSignInRequired);
    await assert.rejects(auth.signIn(false, () => {}), LokiAuthError);
    assert.equal(await readFile(path, "utf8"), corrupt);
    await assert.rejects(auth.account(), LokiSignInRequired);
    await assert.rejects(auth.getToken(), LokiSignInRequired);
    const recovered = new MockAuthentication(directory, mockBroker({
      acquireTokenInteractive: async () => {
        assert.equal(await readFile(path, "utf8"), corrupt);
        return result;
      },
    }));
    await recovered.signIn(false, () => {});
    assert.equal(await recovered.getToken(), result.accessToken);
    const restarted = new MockAuthentication(directory, mockBroker());
    assert.equal((await restarted.account())?.homeAccountId, account.homeAccountId);
    assert.equal(await restarted.getToken(), "mock-refreshed-token");
    assert.deepEqual(await readdir(join(directory, "auth")), ["cache.json"]);
  }
}));

test("device sign-in preserves corrupt disk cache even if MSAL mutates memory before failing", async (context) => temporary(async (directory) => {
  await mkdir(join(directory, "auth"));
  const path = join(directory, "auth", "cache.json");
  const corrupt = '{"private-token":broken';
  await writeFile(path, corrupt);
  let fail = true;
  context.mock.method(PublicClientApplication.prototype, "acquireTokenByDeviceCode", async function (this: PublicClientApplication) {
    assert.equal(await readFile(path, "utf8"), corrupt);
    this.getTokenCache().deserialize(serializedAccountCache());
    if (fail) throw new Error("mock authentication failed private-token");
    return { ...result, fromPlatformBroker: false };
  });
  const auth = new LokiAuthentication(directory);
  await assert.rejects(auth.signIn(true, () => {}), LokiAuthError);
  assert.equal(await readFile(path, "utf8"), corrupt);
  await assert.rejects(auth.account(), LokiSignInRequired);
  await assert.rejects(auth.getToken(), LokiSignInRequired);
  fail = false;
  await auth.signIn(true, () => {});
  assert.equal((await new LokiAuthentication(directory).account())?.homeAccountId, account.homeAccountId);
  assert.equal(await auth.getToken(), result.accessToken);
  assert.deepEqual(await readdir(join(directory, "auth")), ["cache.json"]);
}));

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

test("device instructions allow only exact official HTTPS hosts and valid user codes", async (context) => temporary(async (directory) => {
  let verificationUri = "";
  let userCode = "ABCD123EF";
  context.mock.method(PublicClientApplication.prototype, "acquireTokenByDeviceCode", async (request: {
    deviceCodeCallback: (value: object) => void;
  }) => {
    request.deviceCodeCallback({ verificationUri, userCode, message: "private-token private-account" });
    return { ...result, fromPlatformBroker: false };
  });
  for (const host of ["microsoft.com", "www.microsoft.com", "login.microsoft.com", "login.microsoftonline.com"]) {
    verificationUri = `https://${host}/device`;
    const messages: string[] = [];
    await new LokiAuthentication(directory).signIn(true, (message) => messages.push(message));
    assert.deepEqual(messages, [`Open ${verificationUri} and enter code ${userCode} to sign in.`]);
  }
  for (verificationUri of [
    "https://evil.invalid/device", "https://login.microsoft.com.evil.invalid/device",
    "https://evil.login.microsoft.com/device", "http://login.microsoft.com/device",
    "http://microsoft.com/devicelogin",
  ]) {
    const messages: string[] = [];
    await assert.rejects(new LokiAuthentication(directory).signIn(true, (message) => messages.push(message)), /Invalid device sign-in instructions/);
    assert.deepEqual(messages, []);
  }
  verificationUri = "https://login.microsoft.com/device";
  for (userCode of ["BAD!CODE", "ABC", "A".repeat(33)]) {
    await assert.rejects(new LokiAuthentication(directory).signIn(true, () => assert.fail("must not notify")), /Invalid device sign-in instructions/);
  }
}));

test("a running rejected broker session recovers only after independent successful login and a different token", async () => temporary(async (directory) => {
  let silentToken = result.accessToken;
  let silentCalls = 0;
  const broker = mockBroker({ acquireTokenSilent: async () => {
    silentCalls++;
    return { ...result, accessToken: silentToken };
  } });
  const service = new MockAuthentication(directory, broker);
  await service.signIn(false, () => {});
  const path = join(directory, "auth", "cache.json");
  const before = await readFile(path, "utf8");
  await writeFile(path, "null");
  await assert.rejects(service.getToken(true), /Invalid credential cache/);
  await writeFile(path, before);
  await assert.rejects(service.getToken(), LokiSignInRequired, "cache repair cannot resurrect the rejected token");
  // Rewriting ordinary MSAL cache data cannot masquerade as an explicit login.
  const stored = JSON.parse(before);
  stored.cache = JSON.stringify({ AppMetadata: { offline: { client_id: "offline-client" } } });
  await writeFile(path, JSON.stringify(stored));
  await assert.rejects(service.getToken(), LokiSignInRequired);
  assert.equal(silentCalls, 0);
  const failingCli = new MockAuthentication(directory, mockBroker({ acquireTokenInteractive: async () => { throw new Error("offline failure"); } }));
  const unchanged = await readFile(path, "utf8");
  await assert.rejects(failingCli.signIn(false, () => {}), LokiAuthError);
  assert.equal(await readFile(path, "utf8"), unchanged);
  await assert.rejects(service.getToken(), LokiSignInRequired);
  // Same-instance re-login cannot accept the very token quarantined by its 401.
  await assert.rejects(service.signIn(false, () => {}), /returned the rejected token/);
  assert.equal(await readFile(path, "utf8"), unchanged);

  const moduleUrl = new URL("../src/auth/loki-auth.ts", import.meta.url).href;
  const login = async (token: string) => {
    const code = `
      import { LokiAuthentication } from ${JSON.stringify(moduleUrl)};
      class OfflineCli extends LokiAuthentication {
        async brokerClient() { return { acquireTokenInteractive: async () => ({
          fromPlatformBroker: true, accessToken: ${JSON.stringify(token)},
          account: ${JSON.stringify(account)}, expiresOn: new Date(Date.now() + 3600000),
        }) }; }
      }
      await new OfflineCli(${JSON.stringify(directory)}).signIn(false, () => {});
    `;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
        cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", "ignore", "pipe"],
      });
      let diagnostics = "";
      child.stderr.on("data", (chunk) => { diagnostics += chunk; });
      child.once("error", reject);
      child.once("exit", (status) => status === 0 ? resolve() : reject(new Error(diagnostics)));
    });
  };
  await login(result.accessToken);
  const firstLogin = JSON.parse(await readFile(path, "utf8"));
  assert.notEqual(firstLogin.generation, stored.generation);
  await assert.rejects(service.getToken(), /returned the rejected token/);
  await assert.rejects(service.getToken(true), /returned the rejected token/);
  assert.equal(silentCalls, 2, "new login permits isolated acquisition, never accepting the rejected token");
  silentToken = "independently-renewed-token";
  await login(silentToken);
  assert.notEqual(JSON.parse(await readFile(path, "utf8")).generation, firstLogin.generation);
  assert.deepEqual(await Promise.all(Array.from({ length: 5 }, () => service.getToken())), Array(5).fill(silentToken));
  assert.equal(silentCalls, 3, "running service recovers without restart and shares one acquisition");
  assert.equal(await service.getToken(), silentToken);
}));

test("ordinary successful silent-refresh writes preserve explicit login generation", async (context) => temporary(async (directory) => {
  context.mock.method(PublicClientApplication.prototype, "acquireTokenByDeviceCode", async function (this: PublicClientApplication) {
    this.getTokenCache().deserialize(serializedAccountCache());
    return { ...result, fromPlatformBroker: false };
  });
  await new LokiAuthentication(directory).signIn(true, () => {});
  const path = join(directory, "auth", "cache.json");
  const before = JSON.parse(await readFile(path, "utf8"));
  context.mock.method(PublicClientApplication.prototype, "acquireTokenSilent", async function (this: PublicClientApplication) {
    this.getTokenCache().deserialize(serializedAccountCache().replace("test@example.invalid", "updated@example.invalid"));
    return { ...result, accessToken: "offline-refreshed", fromPlatformBroker: false };
  });
  assert.equal(await new LokiAuthentication(directory).getToken(), "offline-refreshed");
  const after = JSON.parse(await readFile(path, "utf8"));
  assert.notEqual(after.cache, before.cache);
  assert.equal(after.generation, before.generation);
}));
