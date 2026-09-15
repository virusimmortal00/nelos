import { isSemanticVersion } from "./experimentation-contract/semantic-version.mjs";

// Version strings are diagnostic metadata. Client names and release formats may
// change independently of the protocol; an unknown format is not a rejection.
export function appServerVersionFromUserAgent(userAgent) {
  if (typeof userAgent !== "string" || userAgent.length > 512 ||
      /[\u0000-\u001f\u007f]/u.test(userAgent)) return null;
  const version = userAgent.match(/^[^/()]+\/([^\s()]+)(?=\s|$)/u)?.[1];
  return isSemanticVersion(version) ? version : null;
}
