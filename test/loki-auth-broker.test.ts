import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, mkdtemp, rm, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { PublicClientApplication, AuthenticationResult } from "@azure/msal-node";
import { brokerChildProgram, isolatedBrokerToken } from "../src/auth/loki-broker.js";
import { LokiAuthentication, LokiAuthError, LokiSignInRequired } from "../src/auth/loki-auth.js";

// Read installed dependency code without importing the platform-native addon or
// initializing WAM. The extension is optional on Linux; the refusal test below
// still runs there. No network, native broker, login, or real credentials needed.
test("installed 5.5.4 plugin parameter conversion demonstrably ignores forceRefresh", async (context) => {
  const require = createRequire(import.meta.url);
  let root: string;
  try { root = dirname(require.resolve("@azure/msal-node-extensions/package.json")); }
  catch { context.skip("optional native extension not installed on this platform"); return; }
  const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(metadata.version, "5.5.4", "re-review native refresh/cancellation guarantees when upgrading");
  const source = await readFile(join(root, "dist", "broker", "NativeBrokerPlugin.mjs"), "utf8");
  const convert = source.slice(source.indexOf("    generateRequestParameters(request) {"), source.indexOf("    chooseRedirectUriByPlatform(request) {"));
  const silent = source.slice(source.indexOf("    async acquireTokenSilent(request) {"), source.indexOf("    async acquireTokenInteractive("));
  assert.match(silent, /this\.generateRequestParameters\(platformRequest\)/);
  assert.match(silent, /AcquireTokenSilentlyAsync\(authParams,/);
  assert.doesNotMatch(silent + convert, /forceRefresh|AbortSignal|[Cc]ancel/);

  const calls: unknown[][] = [];
  class AuthParameters {
    CreateAuthParameters(...values: unknown[]): void { calls.push(["create", ...values]); }
    SetRedirectUri(...values: unknown[]): void { calls.push(["redirect", ...values]); }
    SetRequestedScopes(...values: unknown[]): void { calls.push(["scopes", ...values]); }
    SetAdditionalParameter(...values: unknown[]): void { calls.push(["additional", ...values]); }
  }
  const Plugin = runInNewContext(`(class { ${convert} })`, {
    msalNodeRuntime: { AuthParameters }, AuthenticationScheme: { POP: "pop" },
    RESOURCE: "resource", X_CLIENT_EXTRA_SKU: "x-client-extra-sku", version: metadata.version,
    ServerTelemetryManager: { makeExtraSkuString: () => "offline-sku" },
  }) as new () => { logger: object; generateRequestParameters(request: object): object };
  const plugin = new Plugin();
  plugin.logger = { trace: () => {} };
  const request = {
    clientId: "offline-client", authority: "https://login.microsoftonline.com/organizations",
    scopes: ["offline-scope"], redirectUri: "ms-appx-web://offline",
  };
  plugin.generateRequestParameters({ ...request, forceRefresh: false });
  const normal = [...calls];
  calls.length = 0;
  plugin.generateRequestParameters({ ...request, forceRefresh: true });
  assert.deepEqual(calls, normal, "native auth parameters are IDENTICAL even with forceRefresh=true");
});

test("forced broker calls are never started; rejection quarantines tokens, frees locks/pending and never mutates disk", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "proxy-loki-broker-test-"));
  try {
    let silent = 0;
    let interactive = 0;
    const granted = {
      accessToken: "private-token", idToken: "private-id-token", fromPlatformBroker: true,
      expiresOn: new Date(Date.now() + 3_600_000), account: {
        homeAccountId: "user.tenant", localAccountId: "user", nativeAccountId: "native-user",
        tenantId: "tenant", username: "private-user@example.invalid", environment: "login.microsoftonline.com",
      },
    } as AuthenticationResult;
    const broker = {
      acquireTokenInteractive: async () => { interactive++; return granted; },
      acquireTokenSilent: () => { silent++; return new Promise(() => {}); },
    } as unknown as PublicClientApplication;
    class BrokerAuthentication extends LokiAuthentication {
      protected override async brokerClient(): Promise<PublicClientApplication> { return broker; }
      protected override async acquireBrokerToken() { return { value: "isolated-token", expiresAt: Date.now() + 3_600_000 }; }
    }
    const auth = new BrokerAuthentication(directory);
    await auth.signIn(false, () => {});
    assert.equal(await auth.getToken(), granted.accessToken, "fresh interactive token remains usable");
    const path = join(directory, "auth", "cache.json");
    const before = await readFile(path, "utf8");
    assert.doesNotMatch(before, /private-token|private-id-token/);
    for (const forced of [true, false, true]) {
      await assert.rejects(auth.getToken(forced), (error: Error) => {
        assert.ok(error instanceof LokiSignInRequired);
        assert.match(error.message, /npm run auth:loki/);
        assert.doesNotMatch(error.message, /private-token|private-user|example.invalid/);
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(await readFile(path, "utf8"), before);
      assert.deepEqual(await readdir(join(directory, "auth")), ["cache.json"]);
      assert.equal((await auth.account())?.nativeAccountId, "native-user");
    }
    assert.equal(silent, 0, "an unbounded shared native operation is never launched");
    const restarted = new BrokerAuthentication(directory);
    assert.equal(await restarted.getToken(), "isolated-token");
    // Explicit login is the only supported renewal; no poisoned client or
    // background silent callback can race this write after rejection.
    await auth.signIn(false, () => {});
    assert.equal(interactive, 2);
    assert.equal(await auth.getToken(), granted.accessToken);
    assert.equal(silent, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const settings = { clientId: "offline-client", authority: "https://login.microsoftonline.com/organizations", scopes: ["offline"] };
function childProgram(program: string, children: ChildProcess[]): () => ChildProcess {
  return () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", program], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    children.push(child);
    return child;
  };
}

test("isolated broker timeout kills child before settling; no cache is shared, and later attempts can succeed", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "proxy-loki-isolation-test-"));
  const children: ChildProcess[] = [];
  try {
    let hang = true;
    class IsolatedAuthentication extends LokiAuthentication {
      protected override async brokerClient(): Promise<PublicClientApplication> {
        return { acquireTokenInteractive: async () => ({
          fromPlatformBroker: true, accessToken: "offline-initial", expiresOn: new Date(0),
          account: { homeAccountId: "user.tenant", localAccountId: "user", nativeAccountId: "native", tenantId: "tenant",
            username: "private-user@example.invalid", environment: "login.microsoftonline.com" },
        }) } as unknown as PublicClientApplication;
      }
      protected override async acquireBrokerToken(account: Parameters<typeof isolatedBrokerToken>[0]) {
        const program = brokerChildProgram(settings, {
          msal: import.meta.resolve('@azure/msal-node'),
          extensions: fakeNativeModule(`export class NativeBrokerPlugin {
            isBrokerAvailable = true; setLogger() {}
            async acquireTokenSilent() {
              ${hang ? `await new Promise(resolve => setTimeout(resolve, 5000));` : ''}
              return { fromPlatformBroker: true, accessToken: '${hang ? 'late-private-token' : 'offline-isolated'}',
                expiresOn: new Date(Date.now() + 3600000) };
            }
          }`),
        });
        return isolatedBrokerToken(account, settings, hang ? 1000 : 5000, childProgram(program, children));
      }
    }
    const auth = new IsolatedAuthentication(directory);
    await auth.signIn(false, () => {});
    const path = join(directory, "auth", "cache.json");
    const before = await readFile(path, "utf8");
    const responses = await Promise.allSettled(Array.from({ length: 5 }, () => auth.getToken()));
    assert.equal(children.length, 1);
    for (const response of responses) {
      assert.equal(response.status, "rejected");
      if (response.status === "rejected") assert.match(response.reason.message, /broker timed out/);
    }
    assert.ok(children[0].signalCode || children[0].exitCode !== null, "timeout does not settle before child exit");
    assert.equal(children[0].connected, false);
    assert.equal(await readFile(path, "utf8"), before);
    assert.deepEqual(await readdir(join(directory, "auth")), ["cache.json"]);
    assert.equal((await auth.account())?.nativeAccountId, "native");
    hang = false;
    assert.equal(await auth.getToken(), "offline-isolated", "lock and pending released; fresh child, not poisoned client");
    assert.equal(children.length, 2);
    assert.ok(children[1].signalCode || children[1].exitCode !== null);
    assert.equal(children[1].connected, false);
    assert.equal(await readFile(path, "utf8"), before);
  } finally {
    for (const child of children) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

test("isolated broker errors/malformed replies drop native diagnostics and causes", { timeout: 10000 }, async () => {
  const children: ChildProcess[] = [];
  try {
    for (const message of [
      { error: "private-token private-user@example.invalid" }, { value: "private-token", expiresAt: "private-secret" },
      { error: "interaction_required" }, { error: "unavailable" },
    ]) {
      const launch = childProgram(`process.once('message', () => process.send(${JSON.stringify(message)}));`, children);
      await assert.rejects(isolatedBrokerToken({} as never, settings, 3000, launch), (error: Error) => {
        assert.ok(error instanceof LokiAuthError);
        assert.equal(error instanceof LokiSignInRequired, ["interaction_required", "unavailable"].includes(String(message.error)));
        assert.doesNotMatch(error.message, /private-token|private-user|private-secret|example.invalid/);
        assert.equal(error.cause, undefined);
        return true;
      });
      const child = children.at(-1)!;
      assert.ok(child.signalCode || child.exitCode !== null);
    }
  } finally { for (const child of children) child.kill("SIGKILL"); }
});

function fakeNativeModule(body: string): string {
  return `data:text/javascript;base64,${Buffer.from(body).toString("base64")}`;
}

test("exact eval program uses real MSAL with fake native plugin after restart, sends identifiers only and never writes cache", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "proxy-loki-child-restart-"));
  const children: ChildProcess[] = [];
  try {
    const granted = {
      fromPlatformBroker: true, accessToken: "offline-initial", expiresOn: new Date(0),
      account: { homeAccountId: "user.tenant", localAccountId: "user", nativeAccountId: "native", tenantId: "tenant",
        username: "private-user@example.invalid", environment: "login.microsoftonline.com" },
    } as AuthenticationResult;
    const program = brokerChildProgram(settings, {
      msal: import.meta.resolve("@azure/msal-node"),
      extensions: fakeNativeModule(`
        import assert from 'node:assert/strict';
        export class NativeBrokerPlugin {
          isBrokerAvailable = true;
          setLogger() {}
          async acquireTokenSilent(request) {
            assert.deepEqual(Object.keys(request.account).sort(), ['homeAccountId', 'nativeAccountId']);
            assert.equal(request.account.homeAccountId, 'user.tenant');
            assert.equal(request.accountId, 'native');
            assert.equal(request.forceRefresh, false);
            assert.equal(request.clientId, 'offline-client');
            assert.equal(request.authority, 'https://login.microsoftonline.com/organizations');
            assert.deepEqual(request.scopes, ['offline']);
            // Neither diagnostics nor unused result fields may escape to parent.
            console.log('private-native-output');
            console.error('private-native-error');
            return { fromPlatformBroker: true, accessToken: 'offline-child-token',
              idToken: 'private-id-token', account: { username: 'private-user' },
              expiresOn: new Date(4102444800000) };
          }
        }
      `),
    });
    assert.doesNotMatch(program, /private-user@example|user\.tenant|offline-initial/);
    class RestartAuthentication extends LokiAuthentication {
      protected override async brokerClient(): Promise<PublicClientApplication> {
        return { acquireTokenInteractive: async () => granted } as unknown as PublicClientApplication;
      }
      protected override async acquireBrokerToken(account: Parameters<typeof isolatedBrokerToken>[0]) {
        return isolatedBrokerToken(account, settings, 3000, childProgram(program, children));
      }
    }
    await new RestartAuthentication(directory).signIn(false, () => {});
    const path = join(directory, 'auth', 'cache.json');
    const before = await readFile(path, 'utf8');
    const restarted = new RestartAuthentication(directory);
    assert.equal(await restarted.getToken(), 'offline-child-token');
    assert.equal(await readFile(path, 'utf8'), before);
    assert.equal(children.length, 1);
    assert.equal(children[0].connected, false, 'IPC is closed before the cache lock is released');
    assert.ok(children[0].signalCode || children[0].exitCode !== null);
    assert.deepEqual(await readdir(join(directory, 'auth')), ['cache.json']);
  } finally {
    for (const child of children) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});

test("exact eval program redacts native exceptions, rejects non-broker tokens and unavailable plugins", { timeout: 15000 }, async () => {
  const children: ChildProcess[] = [];
  try {
    for (const [available, response] of [
      [true, `throw new Error('private-native-secret private-user@example.invalid')`],
      [true, `return { accessToken: 'private-unbound-token', fromPlatformBroker: false }`],
      [false, `throw new Error('must never be called')`],
    ] as const) {
      const program = brokerChildProgram(settings, {
        msal: import.meta.resolve('@azure/msal-node'),
        extensions: fakeNativeModule(`export class NativeBrokerPlugin {
          isBrokerAvailable = ${available}; setLogger() {}
          async acquireTokenSilent() { ${response} }
        }`),
      });
      await assert.rejects(isolatedBrokerToken({ homeAccountId: 'offline', nativeAccountId: 'native' }, settings,
        3000, childProgram(program, children)), (error: Error) => {
        assert.ok(error instanceof LokiAuthError);
        assert.doesNotMatch(error.message, /private-|example.invalid/);
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(children.at(-1)!.connected, false);
      assert.ok(children.at(-1)!.signalCode || children.at(-1)!.exitCode !== null);
    }
  } finally { for (const child of children) child.kill('SIGKILL'); }
});

test("child launch errors settle safely without retaining IPC or native diagnostics", { timeout: 5000 }, async () => {
  let child: ChildProcess | undefined;
  const launch = () => child = spawn('nonexistent-offline-broker-executable', [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await assert.rejects(isolatedBrokerToken({ homeAccountId: 'offline', nativeAccountId: 'native' }, settings, 1000, launch),
    (error: Error) => error instanceof LokiAuthError && !/nonexistent|offline-broker/.test(error.message));
  assert.equal(child!.connected, false);
});

test("parent sends only home/native IDs over IPC, never account metadata, settings or cache state", { timeout: 5000 }, async () => {
  const children: ChildProcess[] = [];
  try {
    const launch = childProgram(`
      import assert from 'node:assert/strict';
      process.once('message', message => {
        assert.deepEqual(message, { homeAccountId: 'offline-home', nativeAccountId: 'offline-native' });
        process.send({ value: 'offline-token', expiresAt: 4102444800000 });
      });
    `, children);
    const account = {
      homeAccountId: 'offline-home', nativeAccountId: 'offline-native', username: 'private-user@example.invalid',
      localAccountId: 'private-local', tenantId: 'private-tenant', environment: 'login.microsoftonline.com',
      idToken: 'private-id-token', idTokenClaims: { secret: 'private-claims' },
    };
    assert.deepEqual(await isolatedBrokerToken(account, settings, 3000, launch),
      { value: 'offline-token', expiresAt: 4102444800000 });
    assert.equal(children[0].connected, false);
    assert.ok(children[0].signalCode || children[0].exitCode !== null);
  } finally { for (const child of children) child.kill('SIGKILL'); }
});
