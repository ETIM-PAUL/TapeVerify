import { TelegramApi } from "../telegram.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.log(
    "TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather and put its token in .env.",
  );
  process.exit(1);
}
const me = await new TelegramApi(token).getMe();
console.log(`Telegram bot OK: @${me.username} (id ${me.id})`);
