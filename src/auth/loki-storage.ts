import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import { errorCode, LokiAuthError } from "./loki-errors.js";

const execute = promisify(execFile);

export async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new LokiAuthError("Refusing unsafe credential storage.");
  }
  if (process.platform !== "win32") {
    await chmod(directory, 0o700);
    return;
  }
  const system = join(process.env.SystemRoot || "C:\\Windows", "System32");
  const { stdout } = await execute(join(system, "whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
  const sid = stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
  if (!sid) throw new LokiAuthError("Could not identify the Windows user to protect credential storage.");
  await execute(join(system, "icacls.exe"), [
    directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`,
  ]);
}

export async function atomicWrite(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(text, "utf8");
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function withLock<T>(directory: string, name: string, action: (assertHeld: () => void) => Promise<T>): Promise<T> {
  let compromised = false;
  const assertHeld = () => {
    if (compromised) throw new LokiAuthError("The credential cache lock was lost. Retry authentication.");
  };
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(directory, {
      realpath: false, lockfilePath: join(directory, `${name}.lock`),
      stale: 30_000, update: 5000,
      // An interactive device/browser login can own the lock for five minutes.
      retries: { retries: 3300, minTimeout: 100, maxTimeout: 100, factor: 1 },
      onCompromised: () => { compromised = true; },
    });
  } catch (error) {
    if (errorCode(error) === "ELOCKED") {
      throw new LokiAuthError("Another authentication operation holds the credential cache. Retry when it finishes.");
    }
    throw error;
  }
  try {
    const value = await action(assertHeld);
    assertHeld();
    return value;
  } finally { await release(); }
}
