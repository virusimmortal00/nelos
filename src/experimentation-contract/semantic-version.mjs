function isAsciiDigit(code) {
  return code >= 0x30 && code <= 0x39;
}

function isAsciiLetter(code) {
  return code >= 0x41 && code <= 0x5a || code >= 0x61 && code <= 0x7a;
}

function isNumericIdentifier(value) {
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!isAsciiDigit(value.charCodeAt(index))) return false;
  }
  return value.length === 1 || value.charCodeAt(0) !== 0x30;
}

function areIdentifiersValid(value, { numericLeadingZeroAllowed }) {
  if (value.length === 0) return false;
  let start = 0;
  for (let index = 0; index <= value.length; index += 1) {
    if (index < value.length && value.charCodeAt(index) !== 0x2e) continue;
    if (index === start) return false;
    let numeric = true;
    for (let cursor = start; cursor < index; cursor += 1) {
      const code = value.charCodeAt(cursor);
      if (!isAsciiDigit(code)) numeric = false;
      if (!isAsciiDigit(code) && !isAsciiLetter(code) && code !== 0x2d) {
        return false;
      }
    }
    if (
      numeric &&
      !numericLeadingZeroAllowed &&
      index - start > 1 &&
      value.charCodeAt(start) === 0x30
    ) {
      return false;
    }
    start = index + 1;
  }
  return true;
}

export function parseSemanticVersion(value) {
  if (typeof value !== "string") return null;

  const buildSeparator = value.indexOf("+");
  const versionAndPrerelease = buildSeparator === -1
    ? value
    : value.slice(0, buildSeparator);
  const build = buildSeparator === -1
    ? null
    : value.slice(buildSeparator + 1);
  if (
    build !== null &&
    !areIdentifiersValid(build, { numericLeadingZeroAllowed: true })
  ) {
    return null;
  }

  const prereleaseSeparator = versionAndPrerelease.indexOf("-");
  const core = prereleaseSeparator === -1
    ? versionAndPrerelease
    : versionAndPrerelease.slice(0, prereleaseSeparator);
  const prereleaseText = prereleaseSeparator === -1
    ? null
    : versionAndPrerelease.slice(prereleaseSeparator + 1);
  if (
    prereleaseText !== null &&
    !areIdentifiersValid(prereleaseText, { numericLeadingZeroAllowed: false })
  ) {
    return null;
  }

  const coreParts = core.split(".");
  if (coreParts.length !== 3 || !coreParts.every(isNumericIdentifier)) {
    return null;
  }

  return {
    core: coreParts,
    prerelease: prereleaseText?.split(".") ?? [],
  };
}

export function isSemanticVersion(value) {
  return parseSemanticVersion(value) !== null;
}

function compareNumericIdentifiers(left, right) {
  if (left.length !== right.length) return left.length - right.length;
  return left === right ? 0 : left < right ? -1 : 1;
}

export function compareSemanticVersions(left, right) {
  const leftVersion = parseSemanticVersion(left);
  const rightVersion = parseSemanticVersion(right);
  if (leftVersion === null || rightVersion === null) {
    throw new TypeError("semantic version comparison requires valid versions");
  }

  for (let index = 0; index < 3; index += 1) {
    const comparison = compareNumericIdentifiers(
      leftVersion.core[index],
      rightVersion.core[index],
    );
    if (comparison !== 0) return comparison;
  }

  const leftPrerelease = leftVersion.prerelease;
  const rightPrerelease = rightVersion.prerelease;
  if (leftPrerelease.length === 0 || rightPrerelease.length === 0) {
    if (leftPrerelease.length === rightPrerelease.length) return 0;
    return leftPrerelease.length === 0 ? 1 : -1;
  }

  const length = Math.max(leftPrerelease.length, rightPrerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = leftPrerelease[index];
    const rightIdentifier = rightPrerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = isNumericIdentifier(leftIdentifier);
    const rightNumeric = isNumericIdentifier(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return compareNumericIdentifiers(leftIdentifier, rightIdentifier);
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}
