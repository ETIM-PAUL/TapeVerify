import { createPool } from "@pit/shared";
import { handleUpdate } from "./bot.js";
import { dispatchOutbox, type Log } from "./dispatch.js";
import { TelegramApi } from "./telegram.js";
import { XClient } from "./x.js";

const log: Log = {
  info: (msg, f) =>
    console.log(
      JSON.stringify({ t: new Date().toISOString(), level: "info", scope: "bots", msg, ...f }),
    ),
  warn: (msg, f) =>
    console.warn(
      JSON.stringify({ t: new Date().toISOString(), level: "warn", scope: "bots", msg, ...f }),
    ),
};

const urls = {
  web: process.env.PUBLIC_WEB_URL ?? "http://localhost:5173",
  share: process.env.PUBLIC_SHARE_URL ?? "http://localhost:3001",
};
const pool = createPool();
const telegram = process.env.TELEGRAM_BOT_TOKEN
  ? new TelegramApi(process.env.TELEGRAM_BOT_TOKEN)
  : null;
const x = process.env.X_ACCESS_TOKEN ? new XClient(process.env.X_ACCESS_TOKEN) : null;
log.info("starting", {
  telegram: Boolean(telegram),
  x: Boolean(x),
  web: urls.web,
  share: urls.share,
});

let stopping = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function poll() {
  if (!telegram) return;
  const me = await telegram.getMe();
  log.info("telegram bot ready", { username: me.username });
  let offset = 0;
  while (!stopping) {
    try {
      const updates = await telegram.getUpdates(offset, 25);
      for (const u of updates) {
        offset = u.update_id + 1;
        await handleUpdate(pool, telegram, urls, u).catch((e) =>
          log.warn("update failed", { err: (e as Error).message }),
        );
      }
    } catch (e) {
      log.warn("polling failed", { err: (e as Error).message });
      await sleep(5000);
    }
  }
}

async function post() {
  while (!stopping) {
    try {
      await dispatchOutbox(pool, { telegram, x }, urls, log);
    } catch (e) {
      log.warn("dispatch failed", { err: (e as Error).message });
    }
    await sleep(5000);
  }
}

const done = Promise.all([poll(), post()]);
for (const s of ["SIGINT", "SIGTERM"] as const)
  process.on(s, () => {
    stopping = true;
    setTimeout(() => process.exit(0), 1500);
  });
await done;
await pool.end();
