export class EvidenceError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "EvidenceError";
    this.code = code;
    this.details = details;
  }
}

export function evidenceFailure(code, message, details = null) {
  throw new EvidenceError(code, message, details);
}
