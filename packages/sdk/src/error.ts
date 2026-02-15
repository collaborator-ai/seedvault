export class SeedvaultError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SeedvaultError";
    this.status = status;
  }
}
