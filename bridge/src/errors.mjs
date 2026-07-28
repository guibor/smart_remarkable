export class HttpError extends Error {
  constructor(statusCode, publicMessage) {
    super(publicMessage);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
  }
}

export function publicErrorMessage(error, fallback = "OpenClaw request failed") {
  if (error instanceof HttpError) {
    return error.publicMessage;
  }
  return fallback;
}
