import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { probeAppServerExecutionV1, REVIEWED_EXECUTION_SCHEMA_VERSIONS } from "../src/app-server-execution-profile.mjs";
import { executorAppServerFixture } from "./support/executor-app-server-fixture.mjs";
import { executionProbeResponses, probeSelection } from "./support/execution-probe-fixture.mjs";

for (const version of REVIEWED_EXECUTION_SCHEMA_VERSIONS.filter((value) => value !== "0.152.0")) {
  test(`owned requests conform to the generated ${version} schema`, async (t) => {
    const fixture = JSON.parse(await readFile(new URL(`./fixtures/app-server-owned-execution-${version}.json`, import.meta.url)));
    assert.equal(fixture.codexVersion, version);
    assert.equal(fixture.runtimeExecutionTested, false);
    const validate = new AjvJsonSchemaValidator().getValidator(fixture.requestSchema);
    const responses = executionProbeResponses();
    responses["model/list"].data[0].model = "gpt-6-astra";
    const f = await executorAppServerFixture(t, { overrides: {
      initialize: () => ({ userAgent: `Codex Desktop/${version} (Mac OS; arm64)`,
        codexHome: "/codex", platformFamily: "unix", platformOs: "macos" }),
      ...Object.fromEntries(Object.entries(responses).map(([method, response]) => [method, () => response])),
    } });
    const discovery = await probeAppServerExecutionV1({ observedVersion: version,
      request: (...args) => f.session.request(...args), options: { ...probeSelection, model: "gpt-6-astra" } });
    assert.equal(discovery.state, "discovery-complete");
    assert.equal(discovery.reviewedSchemaVersion, version);
    assert.equal(discovery.executionAuthorized, false);
    f.member.model = "gpt-6-astra";
    await f.create(); await f.title(); await f.start();
    await f.effects.interrupt({ threadId: "owned-task", turnId: "owned-turn" });
    f.state.turns = [{ id: "owned-turn", status: "completed", items: [] }];
    await f.effects.readResult({ threadId: "owned-task", turnId: "owned-turn" });
    for (const request of f.server.requests.filter(({ id }) => id !== undefined)) {
      const result = validate(request);
      assert.equal(result.valid, true, `${request.method}: ${result.errorMessage}`);
      // Generated schemas permit unknown fields; an ignored misspelled policy
      // must also fail this check even when the general schema accepts it.
      const method = fixture.requestSchema.oneOf.find((entry) => entry.properties.method.enum.includes(request.method));
      const ref = method.properties.params.$ref?.split("/").at(-1);
      const params = ref ? fixture.requestSchema.definitions[ref] : method.properties.params;
      for (const key of Object.keys(request.params ?? {})) {
        assert.ok(Object.hasOwn(params.properties, key), `${request.method}.${key} is declared upstream`);
      }
    }
    assert.equal(validate({ id: "bad", method: "turn/start", params: { threadId: "owned-task", input: [] , effort: 42 } }).valid, false);
  });
}
