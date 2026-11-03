import {
  InteractionRequiredAuthError, PublicClientApplication,
  type AccountInfo, type AuthenticationResult, type Configuration,
} from "@azure/msal-node";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { browserSignIn } from "./loki-browser.js";
import {
  authErrorDetail, errorCode, isObject, LokiAuthError, LokiSignInRequired,
  safeAuthError, sanitizedError, signInHint,
} from "./loki-errors.js";
import { atomicWrite, privateDirectory, withLock } from "./loki-storage.js";

export { LokiAuthError, LokiSignInRequired } from "./loki-errors.js";
export type { AccountInfo } from "@azure/msal-node";

const clientId = "aebc6443-996d-45c2-90f0-388ff96faa56";
const authority = "https://login.microsoftonline.com/organizations";
const scopes = ["42c8f7bd-c7a8-4ba9-bc1c-91edfb716247/.default"];
const refreshMargin = 5 * 60_000;
const loggerOptions = { piiLoggingEnabled: false, loggerCallback: () => {} };

type BrokerAccount = AccountInfo & { nativeAccountId: string };

function isBrokerAccount(value: unknown): value is BrokerAccount {
  return isObject(value) && [
    "homeAccountId", "environment", "tenantId", "username", "localAccountId", "nativeAccountId",
  ].every((key) => typeof value[key] === "string" && value[key] !== "");
}

function requiresInteraction(error: unknown): boolean {
  // The optional broker carries its own MSAL classes; instanceof alone is not enough.
  return error instanceof InteractionRequiredAuthError || (isObject(error)
    && ["interaction_required", "consent_required", "login_required", "no_account_found", "invalid_grant"].includes(String(error.errorCode)));
}

export interface TokenSource {
  getToken(forceRefresh?: boolean): Promise<string>;
}

export interface AccessToken {
  value: string;
  expiresAt: number;
}

type PendingRefresh = { promise: Promise<string>; forced: boolean };

export class LokiAuthentication implements TokenSource {
  private readonly client = new PublicClientApplication({
    auth: { clientId, authority },
    system: { loggerOptions },
  });
  private readonly directory: string;
  private prepared: Promise<void> | undefined;
  private current: AccessToken | undefined;
  private pending: PendingRefresh | undefined;
  private nativeClient: Promise<PublicClientApplication | undefined> | undefined;

  constructor(directory: string) {
    this.directory = join(directory, "auth");
  }

  protected brokerClient(): Promise<PublicClientApplication | undefined> {
    return this.nativeClient ??= (async () => {
      if (process.platform !== "win32") return undefined;
      try {
        // Never load native extensions on Linux (including Docker).
        const moduleName = "@azure/msal-node-extensions";
        type Plugin = NonNullable<NonNullable<Configuration["broker"]>["nativeBrokerPlugin"]>;
        const { NativeBrokerPlugin } = await import(moduleName) as { NativeBrokerPlugin: new () => Plugin };
        const nativeBrokerPlugin = new NativeBrokerPlugin();
        if (!nativeBrokerPlugin.isBrokerAvailable) return undefined;
        return new PublicClientApplication({
          auth: { clientId, authority }, broker: { nativeBrokerPlugin }, system: { loggerOptions },
        });
      } catch { return undefined; }
    })();
  }

  private async cached<T>(action: (accountId: string | undefined, brokerAccount: BrokerAccount | undefined) => Promise<{
    value: T; accountId?: string; brokerAccount?: BrokerAccount | null;
  }>, replaceInvalid = false): Promise<T> {
    try {
      this.prepared ??= privateDirectory(this.directory).catch((error: unknown) => {
        this.prepared = undefined;
        throw error;
      });
      await this.prepared;
      return await withLock(this.directory, "cache", async (assertHeld) => {
        const path = join(this.directory, "cache.json");
        const cache = this.client.getTokenCache();
        // A missing file must not resurrect stale MSAL credentials from this instance.
        cache.deserialize("{}");
        let accountId: string | undefined;
        let brokerAccount: BrokerAccount | undefined;
        let text: string | undefined;
        try {
          const info = await lstat(path);
          if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) {
            throw new LokiSignInRequired(`Invalid credential cache. ${signInHint}`);
          }
          text = await readFile(path, "utf8");
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
        if (text !== undefined) {
          try {
            const stored: unknown = JSON.parse(text);
            if (!isObject(stored) || typeof stored.cache !== "string"
              || typeof stored.accountId !== "string" || !stored.accountId) throw new Error("Invalid cache");
            // MSAL accepts some malformed JSON structures without throwing. Fail closed.
            const serialized: unknown = JSON.parse(stored.cache);
            if (!isObject(serialized) || ["Account", "IdToken", "AccessToken", "RefreshToken", "AppMetadata"]
              .some((key) => serialized[key] !== undefined && (!isObject(serialized[key])
                || Object.values(serialized[key]).some((entry) => !isObject(entry))))) throw new Error("Invalid cache");
            accountId = stored.accountId;
            if (stored.brokerAccount !== undefined) {
              if (!isBrokerAccount(stored.brokerAccount) || stored.brokerAccount.homeAccountId !== accountId) throw new Error("Invalid cache");
              brokerAccount = stored.brokerAccount;
            }
            cache.deserialize(stored.cache);
          } catch {
            if (!replaceInvalid) throw new LokiSignInRequired(`Invalid credential cache. ${signInHint}`);
            // Explicit sign-in can recover corrupt JSON, but writes nothing unless
            // authentication succeeds. Unsafe filesystem entries still fail closed.
            accountId = undefined;
            brokerAccount = undefined;
            cache.deserialize("{}");
          }
        }
        const before = cache.serialize();
        const result = await action(accountId, brokerAccount);
        const serialized = cache.serialize();
        assertHeld();
        if (serialized !== before || result.accountId !== undefined || result.brokerAccount !== undefined) {
          await atomicWrite(path, JSON.stringify({
            accountId: result.accountId ?? accountId, cache: serialized,
            brokerAccount: result.brokerAccount === null ? undefined : result.brokerAccount ?? brokerAccount,
          }));
        }
        return result.value;
      });
    } catch (error) { throw sanitizedError(error); }
  }

  /** Reads the selected account from disk, never from the network. */
  async account(): Promise<AccountInfo | undefined> {
    return this.cached(async (accountId, brokerAccount) => ({
      value: brokerAccount ?? (accountId ? await this.client.getTokenCache().getAccountByHomeId(accountId) ?? undefined : undefined),
    }));
  }

  async getToken(forceRefresh = false): Promise<string> {
    if (forceRefresh) this.current = undefined;
    if (this.pending) {
      if (!forceRefresh || this.pending.forced) return this.pending.promise;
      // A 401 must not join an unforced refresh, but concurrent 401s share ONE
      // subsequent forced refresh. Serialize it so an older result cannot win.
      return this.startRefresh(true, this.pending.promise);
    }
    if (this.current && this.current.expiresAt - Date.now() > refreshMargin) return this.current.value;
    return this.startRefresh(forceRefresh);
  }

  private startRefresh(forced: boolean, after?: Promise<string>): Promise<string> {
    const operation = { forced } as PendingRefresh;
    operation.promise = (async () => {
      if (after) await after.catch(() => {});
      try {
        const token = await this.acquire(forced);
        if (this.pending === operation) this.current = token;
        return token.value;
      } catch (error) {
        if (this.pending === operation) this.current = undefined;
        throw sanitizedError(error);
      } finally {
        if (this.pending === operation) this.pending = undefined;
      }
    })();
    this.pending = operation;
    return operation.promise;
  }

  protected async acquire(forceRefresh: boolean): Promise<AccessToken> {
    return this.cached(async (accountId, brokerAccount) => {
      const account = brokerAccount ?? (accountId ? await this.client.getTokenCache().getAccountByHomeId(accountId) : null);
      if (!account) throw new LokiSignInRequired(`Not signed in. ${signInHint}`);
      const client = brokerAccount ? await this.brokerClient() : this.client;
      if (!client) throw new LokiSignInRequired(`The Windows sign-in broker is unavailable. Install optional dependencies. ${signInHint}`);
      try {
        const result = await client.acquireTokenSilent({ account, scopes, forceRefresh });
        if (!result.accessToken) throw new LokiAuthError(`No access token returned. ${signInHint}`);
        return { value: { value: result.accessToken, expiresAt: result.expiresOn?.getTime() ?? 0 } };
      } catch (error) {
        if (requiresInteraction(error)) throw new LokiSignInRequired(safeAuthError(error).message);
        throw new LokiAuthError(`Could not refresh the sign-in (${authErrorDetail(error)}). Check the network connection. ${signInHint}`);
      }
    });
  }

  async signIn(deviceCode: boolean, notify: (message: string) => void): Promise<void> {
    if (this.pending) await this.pending.promise.catch(() => {});
    this.current = undefined;
    let granted: AuthenticationResult | undefined;
    await this.cached(async () => {
      const broker = deviceCode ? undefined : await this.brokerClient();
      if (broker) {
        notify("Opening Windows sign-in for your work account...");
        try {
          granted = await broker.acquireTokenInteractive({
            scopes, prompt: "select_account",
            openBrowser: async () => { throw new LokiAuthError(`The Windows sign-in broker became unavailable. ${signInHint}`); },
          });
        } catch (error) { throw sanitizedError(error); }
        if (!granted.fromPlatformBroker || !isBrokerAccount(granted.account)) {
          throw new LokiAuthError(`Windows sign-in did not return a broker account. ${signInHint}`);
        }
      } else {
        if (!deviceCode && process.platform === "win32") {
          notify("Windows sign-in broker unavailable; using browser sign-in. Token protection requires the broker.");
        }
        granted = await this.interactive(scopes, deviceCode, notify);
      }
      if (!granted.account || !granted.accessToken) throw new LokiAuthError("Sign-in did not return an account and access token.");
      const account = granted.account;
      return {
        value: undefined, accountId: account.homeAccountId,
        brokerAccount: broker ? {
          homeAccountId: account.homeAccountId, environment: account.environment, tenantId: account.tenantId,
          username: account.username, localAccountId: account.localAccountId, nativeAccountId: account.nativeAccountId!,
        } : null,
      };
    }, true);
    if (granted) this.current = { value: granted.accessToken, expiresAt: granted.expiresOn?.getTime() ?? 0 };
  }

  protected async interactive(requested: string[], deviceCode: boolean, notify: (message: string) => void): Promise<AuthenticationResult> {
    try {
      if (deviceCode) {
        const result = await this.client.acquireTokenByDeviceCode({
          scopes: requested,
          deviceCodeCallback: (response) => {
            // Only a verification URL and user code are intentionally exposed, never
            // arbitrary SDK/server messages, tokens, tenant IDs, or account details.
            const url = new URL(response.verificationUri);
            if (url.protocol !== "https:" || !["microsoft.com", "www.microsoft.com", "login.microsoftonline.com"]
              .includes(url.hostname) || !/^[A-Z0-9-]{4,32}$/i.test(response.userCode)) {
              throw new LokiAuthError("Invalid device sign-in instructions.");
            }
            notify(`Open ${url.origin}${url.pathname} and enter code ${response.userCode} to sign in.`);
          },
          timeout: 300,
        });
        if (!result) throw new LokiAuthError("Device sign-in was cancelled.");
        return result;
      }
      return await browserSignIn(this.client, requested, notify);
    } catch (error) { throw sanitizedError(error); }
  }
}
