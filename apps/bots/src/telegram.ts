type Fetch = typeof fetch;

export interface TgUser {
  id: number;
  username?: string;
  is_bot?: boolean;
}
export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
}
export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  my_chat_member?: { chat: TgChat; from: TgUser; new_chat_member: { status: string } };
}

export class TelegramError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
  /** The bot can't post there any more (removed, blocked, chat gone): stop trying. */
  get permanent() {
    return this.code === 400 || this.code === 403 || this.code === 404;
  }
}

/** The few Bot API calls Pit needs, over plain fetch. */
export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly f: Fetch = fetch,
  ) {}

  private async call<T>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    const res = await this.f(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      description?: string;
      error_code?: number;
    };
    if (!data.ok)
      throw new TelegramError(
        data.error_code ?? res.status,
        `${method}: ${data.description ?? res.statusText}`,
      );
    return data.result as T;
  }

  getMe = () => this.call<{ id: number; username: string }>("getMe");

  getUpdates = (offset: number, timeoutS: number) =>
    this.call<TgUpdate[]>("getUpdates", {
      offset,
      timeout: timeoutS,
      allowed_updates: ["message", "my_chat_member"],
    });

  sendMessage = (chatId: string | number, text: string, extra: Record<string, unknown> = {}) =>
    this.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      ...extra,
    });

  getChatMember = (chatId: string | number, userId: number) =>
    this.call<{
      status: "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";
    }>("getChatMember", {
      chat_id: chatId,
      user_id: userId,
    });
}

/** Telegram refuses localhost links in buttons; use a button only when the URL can be opened by anyone. */
export const buttonable = (url: string) => {
  try {
    const h = new URL(url);
    return (
      (h.protocol === "https:" || h.protocol === "http:") &&
      !["localhost", "127.0.0.1", "0.0.0.0"].includes(h.hostname)
    );
  } catch {
    return false;
  }
};
