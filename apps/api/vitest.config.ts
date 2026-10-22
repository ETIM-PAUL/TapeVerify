import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { defineConfig } from "vitest/config";

// Live tests that call OpenAI need the key from the repo's .env; nothing else is injected.
const file = resolve(import.meta.dirname, "../../.env");
const all = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
const env = Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith("OPENAI_")));

export default defineConfig({
  test: { globalSetup: ["test/global-setup.ts"], fileParallelism: false, env },
});
