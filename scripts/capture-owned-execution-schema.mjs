import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Consume only local output of `codex app-server generate-json-schema
// --experimental --out <directory>`. This collector cannot launch an agent.
const [directory, codexVersion, output] = process.argv.slice(2);
if (!directory || !codexVersion || !output || process.argv.length !== 5) {
  throw new Error("usage: node scripts/capture-owned-execution-schema.mjs <schema-directory> <codex-version> <output.json>");
}
const methods = ["initialize", "account/read", "model/list", "permissionProfile/list",
  "configRequirements/read", "thread/start", "thread/name/set", "thread/read", "turn/start", "turn/interrupt"];
const files = ["ClientRequest.json", "ClientNotification.json", "ServerRequest.json", "ServerNotification.json",
  "v1/InitializeResponse.json", "v2/GetAccountResponse.json", "v2/ModelListResponse.json",
  "v2/PermissionProfileListResponse.json", "v2/ConfigRequirementsReadResponse.json",
  "v2/ThreadStartResponse.json", "v2/ThreadSetNameResponse.json", "v2/ThreadReadResponse.json",
  "v2/TurnStartResponse.json", "v2/TurnInterruptResponse.json"];
const schemas = {};
const sourceSha256 = {};
for (const file of files) {
  const bytes = await readFile(join(directory, file));
  sourceSha256[file] = createHash("sha256").update(bytes).digest("hex");
  schemas[file] = JSON.parse(bytes);
}
function stripAnnotations(value) {
  if (Array.isArray(value)) return value.map(stripAnnotations);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["description", "title"].includes(key))
    .map(([key, child]) => [key, stripAnnotations(child)]));
}
const client = schemas["ClientRequest.json"];
const oneOf = methods.map((method) => {
  const schema = client.oneOf.find((entry) => entry.properties?.method?.enum?.includes(method));
  if (!schema) throw new Error(`missing generated method ${method}`);
  return schema;
});
const definitions = {};
function collectRefs(value) {
  if (!value || typeof value !== "object") return;
  if (value.$ref) {
    const name = value.$ref.replace(/^#\/definitions\//u, "");
    if (!Object.hasOwn(definitions, name)) {
      if (!client.definitions[name]) throw new Error(`unresolved generated reference ${value.$ref}`);
      definitions[name] = client.definitions[name];
      collectRefs(definitions[name]);
    }
  }
  for (const child of Object.values(value)) collectRefs(child);
}
collectRefs(oneOf);
const requestSchema = stripAnnotations({ $schema: client.$schema, oneOf, definitions });
await writeFile(output, `${JSON.stringify({ schemaVersion: 1, codexVersion,
  runtimeExecutionTested: false, sourceCommand: "codex app-server generate-json-schema --experimental --out <directory>",
  sourceSha256, requestSchema }, null, 2)}\n`);
