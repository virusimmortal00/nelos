export class CorpusError extends Error {
  constructor(code, message, path = "") {
    super(message);
    this.name = "CorpusError";
    this.code = code;
    this.path = path;
  }
}

export function corpusFailure(code, message, path = "") {
  throw new CorpusError(code, message, path);
}
