export class StrikeApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly method?: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = "StrikeApiError";
  }
}
