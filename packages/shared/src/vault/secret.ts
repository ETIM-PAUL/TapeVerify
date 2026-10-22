import { inspect } from "node:util";

/**
 * Wraps a sensitive string so it can't leak through JSON.stringify, template strings,
 * console.log or util.inspect. The only way to read it is `reveal()`.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return "[REDACTED]";
  }

  toJSON(): string {
    return "[REDACTED]";
  }

  [inspect.custom](): string {
    return "Secret([REDACTED])";
  }
}
