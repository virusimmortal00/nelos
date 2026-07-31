import assert from "node:assert/strict";
import test from "node:test";

import * as contract from "nelos/experimentation-contract";
import * as indexContract from "nelos/experimentation-contract/index.mjs";

test("package self-reference exposes the assembled experimentation contract index", () => {
  assert.deepEqual(Object.keys(contract).sort(), Object.keys(indexContract).sort());

  for (const api of [
    "ContractError",
    "canonicalize",
    "deriveIdentity",
    "createVersionDispatcher",
    "reviseRecord",
    "createLifecycle",
  ]) {
    assert.equal(typeof contract[api], "function", `${api} is exported`);
  }

  for (const api of [
    "validateExperiment",
    "createCorpusRelease",
    "validateTask",
    "validateRuntimeLock",
  ]) {
    assert.equal(typeof contract[api], "function", `${api} is exported`);
    assert.strictEqual(contract[api], indexContract[api]);
  }
});
