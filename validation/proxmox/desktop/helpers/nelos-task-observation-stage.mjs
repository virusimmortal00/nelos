#!/usr/bin/env node
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const root = process.env.NELOS_DESKTOP_HELPER_ROOT || "/";
const at = (path) => root === "/" ? path : `${root}${path}`;
const bindingPath = at("/etc/nelos-desktop/run-binding.json");
const stagingPath = at("/etc/nelos-desktop/observation-staging.json");
const taskKinds = { "task-native": ["task/native.json", "native-codex"], "task-mcp": ["task/mcp.json", "ordinary-nelos-mcp"], "task-desktop": ["task/desktop.json", "visible-codex-desktop"] };
const archiveKinds = new Set(["native", "mcp", "desktop", "workers"]);
function die(exitCode, code) { process.stderr.write(`${JSON.stringify({ error: code })}\n`); process.exit(exitCode); }
function fields(value, expected) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0"); }
async function trusted(path) { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (root === "/" && (info.uid !== 0 || (info.mode & 0o022) !== 0)) || info.size > 65_536) throw new Error("untrusted"); return JSON.parse(await readFile(path, "utf8")); }

let text=""; for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 1_048_576) die(65,"INPUT_LIMIT"); }
let request,binding,staging;
try { request=JSON.parse(text); [binding,staging]=await Promise.all([trusted(bindingPath),trusted(stagingPath)]); } catch { die(70,"STAGING_UNAVAILABLE"); }
if (!fields(request,["binding","deadlineAt","kind","observation","phase","schemaVersion"]) || request.schemaVersion !== 1 || JSON.stringify(request.binding) !== JSON.stringify(binding) || staging.runId !== binding.runId || !fields(staging,["observationRoot","runId"])) die(77,"IDENTITY_MISMATCH");
const observedAt=Date.parse(request.observation?.observedAt); if (!Number.isFinite(observedAt) || Math.abs(Date.now()-observedAt)>30_000 || Date.parse(request.deadlineAt)<=Date.now() || Date.parse(request.deadlineAt)-Date.now()>60_000 || request.observation.runId!==binding.runId || request.observation.fencingToken!==binding.fencingToken || request.observation.schemaVersion!==1) die(77,"STALE_OBSERVATION");
let relativePath;
if (taskKinds[request.kind]) { const [path,producer]=taskKinds[request.kind]; if (request.phase!==null || request.observation.producer!==producer || !fields(request.observation,["fencingToken","lifecycle","observedAt","producer","runId","schemaVersion","taskId","title"])) die(65,"INVALID_OBSERVATION"); relativePath=path; }
else if (request.kind.startsWith("archive-") && archiveKinds.has(request.kind.slice(8)) && ["afterCleanup","afterRestart"].includes(request.phase)) { relativePath=`archive/${request.phase}/${request.kind.slice(8)}.json`; }
else die(65,"INVALID_OBSERVATION");
const observationRoot=resolve(staging.observationRoot); const target=join(observationRoot,relativePath); if (!target.startsWith(`${observationRoot}${sep}`)) die(77,"UNSAFE_STAGING_PATH");
await mkdir(target.slice(0,target.lastIndexOf(sep)),{recursive:true,mode:0o700});
const canonicalRoot=await realpath(observationRoot); if (canonicalRoot!==observationRoot) die(77,"UNSAFE_STAGING_PATH");
const temporary=`${target}.new`; await writeFile(temporary,`${JSON.stringify(request.observation)}\n`,{mode:0o400}); await rename(temporary,target);
process.stdout.write(`${JSON.stringify({staged:true,kind:request.kind,runId:binding.runId})}\n`);
