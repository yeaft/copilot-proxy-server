export type LogLevel = "debug" | "info" | "warn" | "error";

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

function timestamp(): string {
  return new Date().toISOString();
}

export const logger = {
  setLevel(level: LogLevel) {
    currentLevel = level;
  },

  debug(...args: unknown[]) {
    if (shouldLog("debug")) {
      console.debug(`[${timestamp()}] [DEBUG]`, ...args);
    }
  },

  info(...args: unknown[]) {
    if (shouldLog("info")) {
      console.info(`[${timestamp()}] [INFO]`, ...args);
    }
  },

  warn(...args: unknown[]) {
    if (shouldLog("warn")) {
      console.warn(`[${timestamp()}] [WARN]`, ...args);
    }
  },

  error(...args: unknown[]) {
    if (shouldLog("error")) {
      console.error(`[${timestamp()}] [ERROR]`, ...args);
    }
  },
};
