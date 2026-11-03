import { spawn, type ChildProcess } from "node:child_process";
import type { AccountInfo } from "@azure/msal-node";
import { isObject, LokiAuthError, LokiSignInRequired, signInHint } from "./loki-errors.js";

// A fresh process owns ALL native/MSAL state. It has no cache file path or cache
// plugin, and no refresh/access token is persisted or placed in argv/stdout.
// Terminating a hung native callback can never mutate the parent's MSAL cache.
const brokerProgram = `
  import { createRequire } from 'node:module';
  process.once('disconnect', () => process.exit(0));
  process.once('message', async ({ moduleBase, account, clientId, authority, scopes }) => {
    let reply;
    try {
      const require = createRequire(moduleBase);
      const { PublicClientApplication } = require('@azure/msal-node');
      const { NativeBrokerPlugin } = require('@azure/msal-node-extensions');
      const nativeBrokerPlugin = new NativeBrokerPlugin();
      if (!nativeBrokerPlugin.isBrokerAvailable) {
        reply = { error: 'unavailable' };
      } else {
        const client = new PublicClientApplication({
          auth: { clientId, authority }, broker: { nativeBrokerPlugin },
          system: { loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} } },
        });
        const result = await client.acquireTokenSilent({ account, scopes, forceRefresh: false });
        reply = result.fromPlatformBroker && result.accessToken
          ? { value: result.accessToken, expiresAt: result.expiresOn?.getTime() ?? 0 }
          : { error: 'invalid_result' };
      }
    } catch (error) {
      reply = { error: ['interaction_required', 'consent_required', 'login_required', 'no_account_found', 'invalid_grant']
        .includes(error?.errorCode) ? 'interaction_required' : 'authentication_failed' };
    }
    // Do not forward SDK diagnostics, token payloads on errors, or Error.cause.
    process.send(reply, () => process.exit(0));
  });
`;

type Launch = () => ChildProcess;
const launchBroker: Launch = () => spawn(process.execPath, ["--input-type=module", "-e", brokerProgram], {
  stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
});

/** No shared cache/client and no native cancellation assumption. Kill on timeout,
 * on malformed IPC, and on successful completion; settle only AFTER process exit. */
export function isolatedBrokerToken(
  account: AccountInfo,
  settings: { clientId: string; authority: string; scopes: string[] },
  deadline = 15_000,
  launch: Launch = launchBroker,
): Promise<{ value: string; expiresAt: number }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try { child = launch(); }
    catch { reject(new LokiAuthError(`Could not start the Windows sign-in broker. ${signInHint}`)); return; }
    let result: { value: string; expiresAt: number } | undefined;
    let failure: LokiAuthError | undefined;
    let stopped = false;
    const stop = (error?: LokiAuthError) => {
      if (stopped) return;
      stopped = true;
      failure = error;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop(new LokiAuthError(`The Windows sign-in broker timed out. Retry or ${signInHint}`)), deadline);
    child.once("error", () => stop(new LokiAuthError(`Could not run the Windows sign-in broker. ${signInHint}`)));
    child.once("message", (message: unknown) => {
      if (stopped) return;
      if (isObject(message) && typeof message.value === "string" && message.value.length > 0
        && message.value.length <= 1024 * 1024 && typeof message.expiresAt === "number" && Number.isFinite(message.expiresAt)) {
        result = { value: message.value, expiresAt: message.expiresAt };
        stop();
      } else if (isObject(message) && message.error === "interaction_required") {
        stop(new LokiSignInRequired(`Windows sign-in requires interaction. ${signInHint}`));
      } else if (isObject(message) && message.error === "unavailable") {
        stop(new LokiSignInRequired(`The Windows sign-in broker is unavailable. Install optional dependencies. ${signInHint}`));
      } else {
        stop(new LokiAuthError(`Could not refresh the Windows sign-in. Check the network connection. ${signInHint}`));
      }
    });
    child.once("close", () => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (result) resolve(result);
      else reject(new LokiAuthError(`The Windows sign-in broker stopped without a token. ${signInHint}`));
    });
    try {
      child.send({ account, ...settings, moduleBase: import.meta.url }, (error) => {
        if (error) stop(new LokiAuthError(`Could not contact the Windows sign-in broker. ${signInHint}`));
      });
    } catch { stop(new LokiAuthError(`Could not contact the Windows sign-in broker. ${signInHint}`)); }
  });
}
