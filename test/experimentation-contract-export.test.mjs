import assert from "node:assert/strict";
import test from "node:test";

import * as contract from "nelos/experimentation-contract";
import * as indexContract from "nelos/experimentation-contract/index.mjs";

test("package self-reference exposes the assembled experimentation contract index", () => {
  const contractKeys = Object.keys(contract).sort();
  const indexKeys = Object.keys(indexContract).sort();
  assert.equal(contractKeys.length, 94);
  assert.deepEqual(contractKeys, indexKeys);
  for (const api of contractKeys) {
    assert.strictEqual(contract[api], indexContract[api], `${api} has one identity`);
  }

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
  }
});
