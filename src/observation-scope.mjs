// Scope selection is pure: durable acceptance and cleanup evidence determine
// whether work is settled. Native idle/notLoaded status is not completion.
export function isObservationWaveSettledV1(run, wave, workUnits, decisions) {
  if (!run.verifiedWaveIndexes.includes(wave.waveIndex)) return false;
  if (wave.members.some(({ lifecycle }) => lifecycle === "spinoff") &&
      !(run.cleanedWaveIndexes ?? []).includes(wave.waveIndex)) return false;
  return wave.members.every(({ sliceId }) => {
    const unit = workUnits.find(({ workUnitId }) => workUnitId === sliceId);
    if (!unit) return false;
    if (!unit.required) return true;
    return unit.binding.state === "bound" && decisions.some((decision) =>
      decision.decision === "accepted" &&
      decision.result?.outcome === "succeeded" &&
      decision.webId === unit.webId &&
      decision.queenThreadId === unit.queenThreadId &&
      decision.workUnitId === unit.workUnitId &&
      decision.specRevision === unit.specRevision &&
      decision.attempt === unit.attempt &&
      decision.memberThreadId === unit.binding.memberThreadId);
  });
}

export function selectObservationRunV1({ runs, checkpoint, workUnits, decisions, receipt = null }) {
  const verified = runs.filter(({ verifiedWaveIndexes }) => verifiedWaveIndexes.length > 0);
  // A verified replan supersedes only its own lineage, not independent plans.
  const candidates = verified.filter((run) => !verified.some((other) =>
    other.rootPlanRunId === (run.rootPlanRunId ?? run.planRunId) &&
    other.replanGeneration > run.replanGeneration));
  const pinned = candidates.find(({ planRunId }) => planRunId === checkpoint?.waveScope?.planRunId);
  if (receipt !== null && checkpoint?.waveScope) {
    if (!pinned) throw new Error("observation receipt scope is no longer current");
    selectObservationWaveV1(pinned, { checkpoint, workUnits, decisions, receipt });
    return pinned;
  }
  const unfinished = candidates.filter((run) =>
    !run.waves.every((wave) => isObservationWaveSettledV1(run, wave, workUnits, decisions)));
  // Keep in-flight work stable when another plan is registered. Once settled,
  // resume unresolved work even if a completed plan sorts before it by hash.
  return unfinished.find((run) => run === pinned) ?? unfinished[0] ?? pinned ?? candidates[0] ?? null;
}

function selectObservationWaveV1(run, { checkpoint, workUnits, decisions, receipt = null }) {
  const waves = run.verifiedWaveIndexes.map((index) => run.waves.find((wave) => wave.waveIndex === index));
  if (waves.some((wave) => !wave)) throw new Error("observation receipt wave is no longer current: verified wave contract is unavailable");
  if (receipt !== null && checkpoint?.waveScope) {
    const wave = waves.find(({ waveIndex, waveDigest }) =>
      waveIndex === checkpoint.waveScope.waveIndex && waveDigest === checkpoint.waveScope.waveDigest);
    if (!wave) throw new Error("observation receipt wave is no longer current");
    return wave;
  }
  const latest = waves.at(-1);
  // Keep the latest launched wave active until it settles, then recover any
  // older verified wave whose exact acceptance or cleanup evidence is missing.
  return !isObservationWaveSettledV1(run, latest, workUnits, decisions) ? latest :
    waves.find((wave) => !isObservationWaveSettledV1(run, wave, workUnits, decisions)) ?? latest;
}

export function selectObservationScopeV1(input) {
  const run = selectObservationRunV1(input);
  if (!run) return { run: null, wave: null, scope: null };
  const wave = selectObservationWaveV1(run, input);
  return { run, wave, scope: { planRunId: run.planRunId, waveIndex: wave.waveIndex, waveDigest: wave.waveDigest } };
}
