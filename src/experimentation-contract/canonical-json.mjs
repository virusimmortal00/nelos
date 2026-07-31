import { contractFailure, errorContext } from "./errors.mjs";

const objectPrototype = Object.prototype;

export function jsonPointerToken(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

export function appendJsonPointer(path, token) {
  return `${path}/${jsonPointerToken(token)}`;
}

function fail(code, message, path, options) {
  contractFailure(code, message, { path, ...errorContext(options) });
}

function assertUnicodeScalarString(value, path, options, subject = "string") {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        fail(
          "invalid_unicode",
          `${subject} must contain only Unicode scalar values`,
          path,
          options,
        );
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail(
        "invalid_unicode",
        `${subject} must contain only Unicode scalar values`,
        path,
        options,
      );
    }
  }
}

function serialize(value, path, active, visited, options) {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      assertUnicodeScalarString(value, path, options);
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        fail("non_finite_number", "number must be finite", path, options);
      }
      if (Object.is(value, -0)) {
        fail("non_canonical_number", "negative zero is not canonical", path, options);
      }
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        fail(
          "unsafe_integer",
          "integer must be within the interoperable safe-integer range",
          path,
          options,
        );
      }
      return JSON.stringify(value);
    case "object":
      break;
    default:
      fail(
        "unsupported_json_type",
        "value must be null, boolean, string, number, array, or plain object",
        path,
        options,
      );
  }

  if (active.has(value)) {
    fail("cyclic_value", "canonical JSON cannot contain cycles", path, options);
  }
  if (visited.has(value)) {
    fail(
      "repeated_reference",
      "canonical JSON cannot contain repeated object references",
      path,
      options,
    );
  }
  visited.add(value);
  active.add(value);
  try {
    if (Array.isArray(value)) {
      for (const key of Reflect.ownKeys(value)) {
        if (
          key === "length" ||
          (typeof key === "string" &&
            /^(?:0|[1-9][0-9]*)$/u.test(key) &&
            Number(key) < value.length)
        ) {
          continue;
        }
        fail(
          "unsupported_array_property",
          "canonical JSON arrays cannot contain named or symbol properties",
          path,
          options,
        );
      }
      const entries = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          fail(
            "sparse_array",
            "canonical JSON arrays cannot contain holes",
            appendJsonPointer(path, index),
            options,
          );
        }
        entries.push(
          serialize(
            value[index],
            appendJsonPointer(path, index),
            active,
            visited,
            options,
          ),
        );
      }
      return `[${entries.join(",")}]`;
    }

    if (
      Object.getPrototypeOf(value) !== objectPrototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      fail(
        "unsupported_json_object",
        "canonical JSON objects must have the default object prototype",
        path,
        options,
      );
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length > 0) {
      fail(
        "unsupported_json_type",
        "canonical JSON objects cannot contain symbol properties",
        path,
        options,
      );
    }

    const keys = Object.keys(value).sort();
    if (Object.getOwnPropertyNames(value).length !== keys.length) {
      fail(
        "unsupported_json_property",
        "canonical JSON objects cannot contain non-enumerable properties",
        path,
        options,
      );
    }
    const entries = [];
    for (const key of keys) {
      const keyPath = appendJsonPointer(path, key);
      assertUnicodeScalarString(key, keyPath, options, "object key");
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) {
        fail(
          "accessor_property",
          "canonical JSON objects cannot contain accessor properties",
          keyPath,
          options,
        );
      }
      entries.push(
        `${JSON.stringify(key)}:${serialize(
          descriptor.value,
          keyPath,
          active,
          visited,
          options,
        )}`,
      );
    }
    return `{${entries.join(",")}}`;
  } finally {
    active.delete(value);
  }
}

export function canonicalize(value, options = {}) {
  return serialize(value, "", new Set(), new Set(), options);
}

export function canonicalBytes(value, options = {}) {
  return Buffer.from(canonicalize(value, options), "utf8");
}

function parseFailure(code, message, path, options) {
  contractFailure(code, message, {
    path,
    contractKind: options.contractKind ?? "CanonicalJson",
    schemaVersion: options.schemaVersion ?? 1,
  });
}

function parseJsonText(text, options) {
  let offset = 0;

  function skipWhitespace() {
    while (
      text[offset] === " " ||
      text[offset] === "\n" ||
      text[offset] === "\r" ||
      text[offset] === "\t"
    ) {
      offset += 1;
    }
  }

  function parseString(path) {
    const start = offset;
    if (text[offset] !== '"') {
      parseFailure("invalid_json_syntax", "expected a JSON string", path, options);
    }
    offset += 1;
    while (offset < text.length) {
      const character = text[offset];
      if (character === '"') {
        offset += 1;
        try {
          return JSON.parse(text.slice(start, offset));
        } catch {
          parseFailure(
            "invalid_json_syntax",
            "JSON string syntax is invalid",
            path,
            options,
          );
        }
      }
      if (character.charCodeAt(0) < 0x20) {
        parseFailure(
          "invalid_json_syntax",
          "JSON strings cannot contain control characters",
          path,
          options,
        );
      }
      if (character === "\\") {
        offset += 1;
        const escape = text[offset];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/u.test(text.slice(offset + 1, offset + 5))) {
            parseFailure(
              "invalid_json_syntax",
              "JSON Unicode escape is invalid",
              path,
              options,
            );
          }
          offset += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(escape ?? "")) {
          parseFailure(
            "invalid_json_syntax",
            "JSON string escape is invalid",
            path,
            options,
          );
        }
      }
      offset += 1;
    }
    parseFailure("invalid_json_syntax", "JSON string is unterminated", path, options);
  }

  function parseNumber(path) {
    const rest = text.slice(offset);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(rest);
    if (!match) {
      parseFailure("invalid_json_syntax", "JSON number syntax is invalid", path, options);
    }
    offset += match[0].length;
    return Number(match[0]);
  }

  function parseValue(path) {
    const character = text[offset];
    if (character === '"') return parseString(path);
    if (character === "{") return parseObject(path);
    if (character === "[") return parseArray(path);
    if (text.startsWith("true", offset)) {
      offset += 4;
      return true;
    }
    if (text.startsWith("false", offset)) {
      offset += 5;
      return false;
    }
    if (text.startsWith("null", offset)) {
      offset += 4;
      return null;
    }
    if (character === "-" || (character >= "0" && character <= "9")) {
      return parseNumber(path);
    }
    parseFailure("invalid_json_syntax", "JSON value syntax is invalid", path, options);
  }

  function parseArray(path) {
    const value = [];
    offset += 1;
    skipWhitespace();
    if (text[offset] === "]") {
      offset += 1;
      return value;
    }
    for (let index = 0; ; index += 1) {
      value.push(parseValue(appendJsonPointer(path, index)));
      skipWhitespace();
      if (text[offset] === "]") {
        offset += 1;
        return value;
      }
      if (text[offset] !== ",") {
        parseFailure(
          "invalid_json_syntax",
          "JSON array must contain a comma or closing bracket",
          path,
          options,
        );
      }
      offset += 1;
      skipWhitespace();
    }
  }

  function parseObject(path) {
    const value = Object.create(null);
    const keys = new Set();
    offset += 1;
    skipWhitespace();
    if (text[offset] === "}") {
      offset += 1;
      return value;
    }
    for (;;) {
      const key = parseString(path);
      const keyPath = appendJsonPointer(path, key);
      if (keys.has(key)) {
        parseFailure(
          "duplicate_object_key",
          "JSON object keys must be unique",
          keyPath,
          options,
        );
      }
      keys.add(key);
      skipWhitespace();
      if (text[offset] !== ":") {
        parseFailure(
          "invalid_json_syntax",
          "JSON object key must be followed by a colon",
          keyPath,
          options,
        );
      }
      offset += 1;
      skipWhitespace();
      value[key] = parseValue(keyPath);
      skipWhitespace();
      if (text[offset] === "}") {
        offset += 1;
        return value;
      }
      if (text[offset] !== ",") {
        parseFailure(
          "invalid_json_syntax",
          "JSON object must contain a comma or closing brace",
          path,
          options,
        );
      }
      offset += 1;
      skipWhitespace();
    }
  }

  skipWhitespace();
  const value = parseValue("");
  skipWhitespace();
  if (offset !== text.length) {
    parseFailure("trailing_data", "JSON contains trailing data", "", options);
  }
  return value;
}

export function parseCanonicalJsonV1(bytes, options = {}) {
  if (!(bytes instanceof Uint8Array)) {
    parseFailure("invalid_type", "canonical JSON input must be bytes", "", options);
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    parseFailure("utf8_bom", "canonical JSON must not contain a UTF-8 BOM", "", options);
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    parseFailure("invalid_utf8", "canonical JSON must be valid UTF-8", "", options);
  }
  const value = parseJsonText(text, options);
  const expected = canonicalBytes(value, {
    contractKind: options.contractKind ?? "CanonicalJson",
    schemaVersion: options.schemaVersion ?? 1,
  });
  if (
    expected.length !== bytes.length ||
    expected.some((byte, index) => byte !== bytes[index])
  ) {
    parseFailure(
      "non_canonical_json",
      "JSON bytes must exactly match canonical serialization",
      "",
      options,
    );
  }
  return value;
}
