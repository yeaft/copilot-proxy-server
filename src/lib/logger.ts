export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogArg = unknown | (() => unknown);

let currentLevel: LogLevel = "info";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function resolveArgs(args: LogArg[]): unknown[] {
  return args.map((arg) => (typeof arg === "function" ? (arg as () => unknown)() : arg));
}

function timestamp(): string {
  return new Date().toISOString();
}

export const logger = {
  setLevel(level: LogLevel) {
    currentLevel = level;
  },

  isDebugEnabled(): boolean {
    return shouldLog("debug");
  },

  debug(...args: LogArg[]) {
    if (shouldLog("debug")) {
      console.debug(`[${timestamp()}] [DEBUG]`, ...resolveArgs(args));
    }
  },

  info(...args: LogArg[]) {
    if (shouldLog("info")) {
      console.info(`[${timestamp()}] [INFO]`, ...resolveArgs(args));
    }
  },

  warn(...args: LogArg[]) {
    if (shouldLog("warn")) {
      console.warn(`[${timestamp()}] [WARN]`, ...resolveArgs(args));
    }
  },

  error(...args: LogArg[]) {
    if (shouldLog("error")) {
      console.error(`[${timestamp()}] [ERROR]`, ...resolveArgs(args));
    }
  },
};
