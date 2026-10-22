type Fetch = typeof fetch;

export class XError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
  get permanent() {
    return this.status === 400 || this.status === 403;
  }
}

/** Posts from Pit's own X account with a user-context access token. The link's card comes from the page's meta tags. */
export class XClient {
  constructor(
    private readonly accessToken: string,
    private readonly f: Fetch = fetch,
  ) {}

  async post(text: string): Promise<string> {
    const res = await this.f("https://api.x.com/2/tweets", {
      method: "POST",
      headers: { authorization: `Bearer ${this.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      data?: { id: string };
      detail?: string;
      title?: string;
    };
    if (!res.ok || !data.data?.id)
      throw new XError(res.status, `x: ${data.detail ?? data.title ?? res.statusText}`);
    return data.data.id;
  }
}
