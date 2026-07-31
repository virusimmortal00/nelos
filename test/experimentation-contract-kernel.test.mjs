import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_ERROR_CODES_V1,
  LEGACY_CONTRACT_ERROR_CODE_MAP,
  ContractError,
  assertClosedObject,
  assertDigest,
  assertInteger,
  assertRequired,
  assertUniqueIdentities,
  canonicalBytes,
  canonicalDigest,
  canonicalize,
  contractFailure,
  createLifecycle,
  createVersionDispatcher,
  deriveIdentity,
  parseCanonicalJsonV1,
  reviseRecord,
  sealRecord,
  verifyRevision,
} from "../src/experimentation-contract/index.mjs";
import {
  DEFAULT_MAX_CANONICAL_JSON_BYTES,
  DEFAULT_MAX_CANONICAL_JSON_DEPTH,
  MAX_CANONICAL_JSON_BYTES,
  MAX_CANONICAL_JSON_DEPTH,
} from "../src/experimentation-contract/canonical-json.mjs";

function expectContractError(action, code, path) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.code, code);
    assert.equal(error.path, path);
    assert.equal(typeof error.contractKind, "string");
    assert.equal(typeof error.message, "string");
    assert.doesNotMatch(error.message, /super-secret|actual-value/u);
    return true;
  });
}

test("canonical JSON is deterministic across object insertion order", () => {
  const left = { z: [3, { b: true, a: null }], a: "text" };
  const right = { a: "text", z: [3, { a: null, b: true }] };
  assert.equal(canonicalize(left), '{"a":"text","z":[3,{"a":null,"b":true}]}');
  assert.deepEqual(canonicalBytes(left), canonicalBytes(right));
  assert.equal(canonicalDigest(left), canonicalDigest(right));
  assert.match(canonicalDigest(left), /^sha256:[0-9a-f]{64}$/u);
});

test("canonical JSON handles number and Unicode edge cases explicitly", () => {
  assert.equal(
    canonicalize({ exponent: 1e-7, fractional: 0.002, unicode: "é😀" }),
    '{"exponent":1e-7,"fractional":0.002,"unicode":"é😀"}',
  );
  expectContractError(
    () => canonicalize(-0, { contractKind: "Fixture", schemaVersion: 1 }),
    "NON_CANONICAL_NUMBER",
    "",
  );
  expectContractError(() => canonicalize(Number.NaN), "NON_FINITE_NUMBER", "");
  expectContractError(
    () => canonicalize(Number.MAX_SAFE_INTEGER + 1),
    "UNSAFE_INTEGER",
    "",
  );
  expectContractError(() => canonicalize("\ud800"), "INVALID_UNICODE", "");
});

test("canonical JSON rejects unsupported, sparse, cyclic, and accessor inputs", () => {
  expectContractError(() => canonicalize(undefined), "UNSUPPORTED_JSON_TYPE", "");
  expectContractError(() => canonicalize(1n), "UNSUPPORTED_JSON_TYPE", "");
  expectContractError(() => canonicalize(new Date()), "UNSUPPORTED_JSON_OBJECT", "");
  expectContractError(
    () => canonicalize([, 1]),
    "SPARSE_ARRAY",
    "/0",
  );

  const cyclic = {};
  cyclic.self = cyclic;
  expectContractError(
    () => canonicalize(cyclic),
    "CYCLIC_VALUE",
    "/self",
  );

  const accessor = {};
  Object.defineProperty(accessor, "secret", {
    enumerable: true,
    get() {
      throw new Error("super-secret");
    },
  });
  expectContractError(
    () => canonicalize(accessor),
    "ACCESSOR_PROPERTY",
    "/secret",
  );
});

test("canonical JSON accepts null-prototype records and rejects shared references", () => {
  const record = Object.create(null);
  record.value = 1;
  record.nested = Object.assign(Object.create(null), { ok: true });
  assert.equal(canonicalize(record), '{"nested":{"ok":true},"value":1}');
  assert.equal(
    assertClosedObject(record, ["value", "nested"], {
      contractKind: "Fixture",
      schemaVersion: 1,
    }),
    record,
  );

  const shared = { stable: true };
  expectContractError(
    () => canonicalize({ first: shared, second: shared }),
    "REPEATED_REFERENCE",
    "/second",
  );
});

test("parseCanonicalJsonV1 accepts only exact canonical UTF-8 bytes", () => {
  const parsed = parseCanonicalJsonV1(
    Buffer.from('{"a":[true,null],"b":"é"}', "utf8"),
  );
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.deepEqual(parsed.a, [true, null]);
  assert.equal(parsed.b, "é");

  expectContractError(
    () => parseCanonicalJsonV1(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])),
    "UTF8_BOM",
    "",
  );
  expectContractError(
    () => parseCanonicalJsonV1(Buffer.from([0xc3, 0x28])),
    "INVALID_UTF8",
    "",
  );
  expectContractError(
    () => parseCanonicalJsonV1(Buffer.from('{"a":1,"\\u0061":2}')),
    "DUPLICATE_OBJECT_KEY",
    "/a",
  );
  expectContractError(
    () => parseCanonicalJsonV1(Buffer.from('{"a":1}false')),
    "TRAILING_DATA",
    "",
  );
  for (const text of ['{"b":2,"a":1}', '{ "a":1}', '{"a":1}\n']) {
    expectContractError(
      () => parseCanonicalJsonV1(Buffer.from(text)),
      "NON_CANONICAL_JSON",
      "",
    );
  }
});

test("canonical JSON enforces byte and container-depth bounds", () => {
  const testMaxBytes = 128;
  const boundaryValue = "x".repeat(testMaxBytes - 2);
  const boundaryBytes = canonicalBytes(boundaryValue, {
    maxBytes: testMaxBytes,
  });
  assert.equal(boundaryBytes.length, testMaxBytes);
  assert.equal(
    parseCanonicalJsonV1(boundaryBytes, { maxBytes: testMaxBytes }),
    boundaryValue,
  );

  expectContractError(
    () => canonicalize(`${boundaryValue}x`, { maxBytes: testMaxBytes }),
    "OUT_OF_BOUNDS",
    "",
  );
  expectContractError(
    () => parseCanonicalJsonV1(Buffer.alloc(testMaxBytes + 1), {
      maxBytes: testMaxBytes,
    }),
    "OUT_OF_BOUNDS",
    "",
  );

  const testMaxDepth = 4;
  let boundaryDepth = 0;
  for (let depth = 0; depth < testMaxDepth; depth += 1) {
    boundaryDepth = [boundaryDepth];
  }
  const boundaryDepthBytes = canonicalBytes(boundaryDepth, {
    maxDepth: testMaxDepth,
  });
  assert.deepEqual(
    parseCanonicalJsonV1(boundaryDepthBytes, { maxDepth: testMaxDepth }),
    boundaryDepth,
  );

  const excessiveDepth = [boundaryDepth];
  const excessivePath = "/0".repeat(testMaxDepth);
  expectContractError(
    () => canonicalize(excessiveDepth, { maxDepth: testMaxDepth }),
    "OUT_OF_BOUNDS",
    excessivePath,
  );
  expectContractError(
    () =>
      parseCanonicalJsonV1(
        Buffer.from(canonicalize(boundaryDepth).replace("0", "[0]")),
        { maxDepth: testMaxDepth },
      ),
    "OUT_OF_BOUNDS",
    excessivePath,
  );
});

test("canonical JSON accepts only validated caller-specific limits", () => {
  assert.equal(DEFAULT_MAX_CANONICAL_JSON_BYTES, 64 * 1024 * 1024);
  assert.equal(MAX_CANONICAL_JSON_BYTES, 256 * 1024 * 1024);
  assert.equal(DEFAULT_MAX_CANONICAL_JSON_DEPTH, 64);
  assert.equal(MAX_CANONICAL_JSON_DEPTH, 64);

  expectContractError(
    () => canonicalize([[0]], { maxDepth: 1 }),
    "OUT_OF_BOUNDS",
    "/0",
  );
  assert.throws(
    () => canonicalize(null, { maxBytes: MAX_CANONICAL_JSON_BYTES + 1 }),
    TypeError,
  );
  assert.throws(
    () => parseCanonicalJsonV1(Buffer.from("null"), { maxDepth: 0 }),
    TypeError,
  );
  assert.throws(
    () => canonicalize(null, { maxBytes: 1.5 }),
    TypeError,
  );
  assert.throws(
    () => canonicalize(null, { maxDepth: MAX_CANONICAL_JSON_DEPTH + 1 }),
    TypeError,
  );
});

test("identity helpers require explicit projections and exclude other fields", () => {
  const first = {
    task: "task:a",
    revision: 1,
    displayName: "first name",
    token: "super-secret",
  };
  const second = {
    token: "different-secret",
    displayName: "renamed",
    revision: 1,
    task: "task:a",
  };
  const fields = ["task", "revision"];
  assert.equal(deriveIdentity(first, fields), deriveIdentity(second, fields));
  assert.equal(
    deriveIdentity(first, ({ task, revision }) => ({ task, revision })),
    deriveIdentity(first, fields),
  );
  expectContractError(
    () => deriveIdentity(first),
    "IDENTITY_PROJECTION_REQUIRED",
    "",
  );
  expectContractError(
    () =>
      deriveIdentity(first, () => {
        contractFailure("unknown_field", "projected field is unknown", {
          path: "/metricId",
          contractKind: "Experiment",
          schemaVersion: 1,
        });
      }),
    "UNKNOWN_FIELD",
    "/metricId",
  );
  expectContractError(
    () =>
      deriveIdentity(first, () => {
        throw new Error("super-secret");
      }),
    "IDENTITY_PROJECTION_FAILED",
    "",
  );
});

test("validation is closed, bounded, version-exact, and structured", () => {
  const validateV1 = createVersionDispatcher({
    contractKind: "Example",
    versions: {
      1(value, options) {
        assertClosedObject(value, ["schemaVersion", "count", "digest"], options);
        assertRequired(value, ["schemaVersion", "count", "digest"], options);
        assertInteger(value.count, {
          minimum: 1,
          maximum: 5,
          path: "/count",
          ...options,
        });
        assertDigest(value.digest, { path: "/digest", ...options });
        return value;
      },
    },
  });
  const valid = {
    schemaVersion: 1,
    count: 2,
    digest: `sha256:${"a".repeat(64)}`,
  };
  assert.equal(validateV1(valid), valid);
  expectContractError(
    () => validateV1({ ...valid, actualValue: "actual-value" }),
    "UNKNOWN_FIELD",
    "/actualValue",
  );
  expectContractError(
    () => validateV1({ ...valid, count: 9 }),
    "OUT_OF_BOUNDS",
    "/count",
  );
  assert.throws(
    () => validateV1({ ...valid, schemaVersion: 2 }),
    (error) => {
      assert.ok(error instanceof ContractError);
      assert.deepEqual(error.toJSON(), {
        code: "UNSUPPORTED_SCHEMA_VERSION",
        path: "/schemaVersion",
        contractKind: "Example",
        schemaVersion: 2,
        message: "schemaVersion is not supported; explicit migration is required",
        details: null,
      });
      return true;
    },
  );

  expectContractError(
    () => validateV1({ count: 2, digest: valid.digest }),
    "REQUIRED_FIELD",
    "/schemaVersion",
  );
});

test("duplicate identity rejection reports the later array position", () => {
  expectContractError(
    () =>
      assertUniqueIdentities(
        [{ id: "a" }, { id: "b" }, { id: "a" }],
        ({ id }) => id,
        { path: "/items", contractKind: "Example", schemaVersion: 1 },
      ),
    "DUPLICATE_IDENTITY",
    "/items/2",
  );
});

test("revisions require sealed lineage and a semantic digest change", () => {
  const baseMaterial = {
    schemaVersion: 1,
    revision: 1,
    name: "task",
    objective: "old",
    previousDigest: null,
  };
  const base = sealRecord({
    ...baseMaterial,
    digest: canonicalDigest({
      schemaVersion: 1,
      name: "task",
      objective: "old",
    }),
  });
  const projection = ({ name, objective }) => ({ name, objective });
  const next = reviseRecord(base, { objective: "new" }, {
    identityProjection: projection,
    contractKind: "Task",
    schemaVersion: 1,
  });

  assert.equal(next.revision, 2);
  assert.equal(next.previousDigest, base.digest);
  assert.notEqual(next.digest, base.digest);
  assert.equal(base.objective, "old");
  assert.ok(Object.isFrozen(next));
  assert.equal(verifyRevision(base, next, {
    identityProjection: projection,
    contractKind: "Task",
    schemaVersion: 1,
  }), next);

  expectContractError(
    () => reviseRecord(base, { objective: "old" }, {
      identityProjection: projection,
      contractKind: "Task",
    }),
    "REVISION_WITHOUT_SEMANTIC_CHANGE",
    "",
  );
  expectContractError(
    () => reviseRecord({ ...base }, { objective: "other" }),
    "RECORD_NOT_SEALED",
    "",
  );
  assert.throws(() => {
    next.objective = "mutated";
  }, TypeError);
});

test("lifecycle transitions are declared and never mutate inputs", () => {
  const transition = createLifecycle({
    contractKind: "Experiment",
    transitions: {
      draft: ["reviewed", "invalidated"],
      reviewed: ["sealed", "invalidated"],
      sealed: ["running", "invalidated"],
      running: ["stopped", "completed", "invalidated"],
      completed: ["reported"],
      reported: ["archived"],
    },
    terminalStates: ["stopped", "archived", "invalidated"],
  });
  const draft = sealRecord({ state: "draft", name: "experiment" });
  const reviewed = transition(draft, "reviewed");
  assert.equal(draft.state, "draft");
  assert.equal(reviewed.state, "reviewed");
  assert.ok(Object.isFrozen(reviewed));

  expectContractError(
    () => transition(draft, "sealed"),
    "UNAUTHORIZED_TRANSITION",
    "/state",
  );
  expectContractError(
    () => transition(sealRecord({ state: "archived" }), "draft"),
    "TERMINAL_TRANSITION",
    "/state",
  );
  expectContractError(
    () => transition(sealRecord({ state: "unknown" }), "draft"),
    "UNKNOWN_LIFECYCLE_STATE",
    "/state",
  );
});

test("lifecycle configuration clones caller-owned Maps and target containers", () => {
  const draftTargets = ["reviewed"];
  const reviewedTargets = new Set(["sealed"]);
  const transitions = new Map([
    ["draft", draftTargets],
    ["reviewed", reviewedTargets],
  ]);
  const transition = createLifecycle({
    contractKind: "Experiment",
    transitions,
    terminalStates: ["sealed"],
  });

  assert.equal(transitions.get("draft"), draftTargets);
  assert.equal(transitions.get("reviewed"), reviewedTargets);
  assert.deepEqual(draftTargets, ["reviewed"]);
  assert.deepEqual([...reviewedTargets], ["sealed"]);

  draftTargets.push("sealed");
  reviewedTargets.add("draft");
  transitions.set("draft", ["sealed"]);

  expectContractError(
    () => transition(sealRecord({ state: "draft" }), "sealed"),
    "UNAUTHORIZED_TRANSITION",
    "/state",
  );
  expectContractError(
    () => transition(sealRecord({ state: "reviewed" }), "draft"),
    "UNAUTHORIZED_TRANSITION",
    "/state",
  );
});

test("ContractError exposes frozen enumerable bounded fields and compatibility codes", () => {
  const error = new ContractError({
    code: CONTRACT_ERROR_CODES_V1.UNKNOWN_FIELD,
    path: "/a~1b~0c",
    contractKind: "Fixture",
    schemaVersion: 1,
    message: "field is not allowed by this contract",
    details: { allowedFieldCount: 2 },
  });
  assert.ok(Object.isFrozen(error));
  assert.ok(Object.isFrozen(error.details));
  assert.deepEqual(Object.keys(error), [
    "message",
    "name",
    "code",
    "path",
    "contractKind",
    "schemaVersion",
    "details",
  ]);
  assert.equal(LEGACY_CONTRACT_ERROR_CODE_MAP.unknown_field, "UNKNOWN_FIELD");
  assert.equal(Object.getPrototypeOf(LEGACY_CONTRACT_ERROR_CODE_MAP), null);
  assert.equal(LEGACY_CONTRACT_ERROR_CODE_MAP.constructor, undefined);
  assert.throws(
    () =>
      new ContractError({
        code: "UNKNOWN_FIELD",
        path: "",
        contractKind: "Fixture",
        message: "x".repeat(257),
      }),
    TypeError,
  );

  expectContractError(
    () =>
      assertClosedObject(
        { "a/b~c": true },
        [],
        { contractKind: "Fixture", schemaVersion: 1 },
      ),
    "UNKNOWN_FIELD",
    "/a~1b~0c",
  );
});
