import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runReleaseDesktopCertificationV1 } from "../scripts/run-desktop-smoke-certification.mjs";
import { runRoutineDesktopSmokeV1 } from "../scripts/run-desktop-smoke-routine.mjs";

test("routine and certification entry points require explicit candidate, output, and run identities", async () => {
  await assert.rejects(runRoutineDesktopSmokeV1(), /candidatePath, outputDirectory, and runId/u);
  await assert.rejects(runReleaseDesktopCertificationV1(), /candidatePath, outputDirectory, and runId/u);
});

test("release workflow keeps VM certification self-hosted and uploads only bounded output", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(workflow, /desktop-certification:/u);
  assert.match(workflow, /runs-on: \[self-hosted, nelos-disposable-desktop\]/u);
  assert.match(workflow, /npm run desktop-smoke:certify/u);
  assert.match(workflow, /needs: \[verify, artifacts, desktop-certification\]/u);
  assert.doesNotMatch(workflow, /OPENAI_API_KEY|PROXMOX_|VMWARE_|AWS_SECRET/u);
});
