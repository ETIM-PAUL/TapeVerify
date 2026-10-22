import pg from "pg";
import { TelegramApi } from "../src/telegram.js";

export const testPool = () => new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });

export interface Sent {
  method: string;
  body: Record<string, any>;
}

/** A Telegram Bot API that records every call. `respond` can override a method's reply. */
export function fakeTelegram(
  respond: (method: string, body: Record<string, any>) => unknown = () => undefined,
) {
  const sent: Sent[] = [];
  let id = 1000;
  const f = (async (url: string, init: { body: string }) => {
    const method = url.split("/").pop() as string;
    const body = JSON.parse(init.body);
    sent.push({ method, body });
    const custom = respond(method, body) as
      | { ok?: boolean; error_code?: number; description?: string; result?: unknown }
      | undefined;
    if (custom)
      return new Response(JSON.stringify(custom), {
        status: custom.ok === false ? (custom.error_code ?? 400) : 200,
      });
    const result =
      method === "sendMessage"
        ? { message_id: ++id }
        : method === "getChatMember"
          ? { status: "administrator" }
          : {};
    return new Response(JSON.stringify({ ok: true, result }));
  }) as unknown as typeof fetch;
  return {
    api: new TelegramApi("TEST:TOKEN", f),
    sent,
    messages: () => sent.filter((s) => s.method === "sendMessage"),
  };
}

export const URLS = { web: "https://tape.example", share: "https://share.tape.example" };
