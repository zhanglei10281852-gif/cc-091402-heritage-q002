export class DomainError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "DomainError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function fail(status, code, message, details) {
  throw new DomainError(status, code, message, details);
}

export function assert(condition, status, code, message, details) {
  if (!condition) fail(status, code, message, details);
}
