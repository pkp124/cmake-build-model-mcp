export class CtestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CtestError";
  }
}
