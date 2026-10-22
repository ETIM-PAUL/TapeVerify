export type Fields = Record<string, unknown>;

export interface Logger {
  info(msg: string, f?: Fields): void;
  warn(msg: string, f?: Fields): void;
  error(msg: string, f?: Fields): void;
  child(scope: string): Logger;
}

export function createLogger(
  scope = "workers",
  sink: (line: string) => void = console.log,
): Logger {
  const emit = (level: string, msg: string, f: Fields = {}) =>
    sink(JSON.stringify({ t: new Date().toISOString(), level, scope, msg, ...f }));
  return {
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (s) => createLogger(`${scope}.${s}`, sink),
  };
}

export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
