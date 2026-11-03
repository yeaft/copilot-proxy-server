import { spawn, type ChildProcess } from "node:child_process";
import type { AccountInfo } from "@azure/msal-node";
import { isObject, LokiAuthError, LokiSignInRequired, signInHint } from "./loki-errors.js";

type Settings = { clientId: string; authority: string; scopes: string[] };
type BrokerIdentity = Pick<AccountInfo, "homeAccountId" | "nativeAccountId">;
type ModuleUrls = { msal: string; extensions: string };

// A fresh process owns ALL native/MSAL state. It has no cache file path or cache
// plugin. Only these two account identifiers travel over IPC, never argv/env.
// Terminating a hung native callback can never mutate the parent's MSAL cache.
// Accepting module URLs also lets offline tests run this exact program with a
// fake native plugin, without loading WAM or needing a separately bundled entry.
export function brokerChildProgram(settings: Settings, modules: ModuleUrls): string {
  return `
    process.once('disconnect', () => process.exit(0));
    process.once('message', async ({ homeAccountId, nativeAccountId }) => {
      let reply;
      try {
        const { PublicClientApplication } = await import(${JSON.stringify(modules.msal)});
        const { NativeBrokerPlugin } = await import(${JSON.stringify(modules.extensions)});
        const nativeBrokerPlugin = new NativeBrokerPlugin();
        if (!nativeBrokerPlugin.isBrokerAvailable) {
          reply = { error: 'unavailable' };
        } else {
          // No cache plugin, serialized MSAL state, or non-broker fallback.
          const noNetwork = async () => { throw new Error('broker_required'); };
          const client = new PublicClientApplication({
            auth: ${JSON.stringify({ clientId: settings.clientId, authority: settings.authority })},
            broker: { nativeBrokerPlugin },
            system: {
              loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} },
              networkClient: { sendGetRequestAsync: noNetwork, sendPostRequestAsync: noNetwork },
            },
          });
          const result = await client.acquireTokenSilent({
            account: { homeAccountId, nativeAccountId },
            scopes: ${JSON.stringify(settings.scopes)}, forceRefresh: false,
          });
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
}

type Launch = () => ChildProcess;
function launchBroker(settings: Settings): ChildProcess {
  // Resolve from the parent module (also when bundled), not the child eval's cwd.
  // Resolve lazily: the optional native dependency must stay optional off Windows.
  const program = brokerChildProgram(settings, {
    msal: import.meta.resolve("@azure/msal-node"),
    extensions: import.meta.resolve("@azure/msal-node-extensions"),
  });
  return spawn(process.execPath, ["--input-type=module", "-e", program], {
    stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
  });
}

/** No shared cache/client and no native cancellation assumption. Kill on timeout,
 * on malformed IPC, and on successful completion; settle only AFTER process exit
 * and IPC closure. If the OS cannot terminate its own child, do not release the
 * lock while native work might still be running. Never race shared-cache work. */
export function isolatedBrokerToken(
  account: BrokerIdentity,
  settings: Settings,
  deadline = 15_000,
  launch: Launch = () => launchBroker(settings),
): Promise<{ value: string; expiresAt: number }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try { child = launch(); }
    catch { reject(new LokiAuthError(`Could not start the Windows sign-in broker. ${signInHint}`)); return; }
    let result: { value: string; expiresAt: number } | undefined;
    let failure: LokiAuthError | undefined;
    let stopped = false;
    let exited = false;
    let ipcClosed = false;
    const finish = () => {
      if (!exited || !ipcClosed) return;
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (result) resolve(result);
      else reject(new LokiAuthError(`The Windows sign-in broker stopped without a token. ${signInHint}`));
    };
    const stop = (error?: LokiAuthError) => {
      if (stopped) return;
      stopped = true;
      failure = error;
      // Close IPC explicitly. Wait for BOTH disconnect and exit, not kill()'s
      // return value. Node on Windows may omit 'close' after manual disconnect.
      if (child.connected) child.disconnect();
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop(new LokiAuthError(`The Windows sign-in broker timed out. Retry or ${signInHint}`)), deadline);
    child.once("error", () => {
      // Failed spawn has no process to wait for (and manual IPC disconnect can
      // suppress 'close' on Windows). Other errors still require actual exit.
      if (child.pid === undefined) exited = true;
      stop(new LokiAuthError(`Could not run the Windows sign-in broker. ${signInHint}`));
      finish();
    });
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
    child.once("disconnect", () => { ipcClosed = true; finish(); });
    child.once("exit", () => { exited = true; finish(); });
    child.once("close", () => {
      // A failed spawn emits error/close, but never exit/disconnect.
      exited = true;
      ipcClosed = !child.connected;
      finish();
    });
    try {
      child.send({ homeAccountId: account.homeAccountId, nativeAccountId: account.nativeAccountId }, (error) => {
        if (error) stop(new LokiAuthError(`Could not contact the Windows sign-in broker. ${signInHint}`));
      });
    } catch { stop(new LokiAuthError(`Could not contact the Windows sign-in broker. ${signInHint}`)); }
  });
}
