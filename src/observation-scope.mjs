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
    const waveIndex = pinned.verifiedWaveIndexes.at(-1);
    const wave = pinned.waves.find((item) => item.waveIndex === waveIndex);
    if (waveIndex !== checkpoint.waveScope.waveIndex || wave?.waveDigest !== checkpoint.waveScope.waveDigest) {
      throw new Error("observation receipt wave is no longer current");
    }
    return pinned;
  }
  const unfinished = candidates.filter((run) =>
    !run.waves.every((wave) => isObservationWaveSettledV1(run, wave, workUnits, decisions)));
  // Keep in-flight work stable when another plan is registered. Once settled,
  // resume unresolved work even if a completed plan sorts before it by hash.
  return unfinished.find((run) => run === pinned) ?? unfinished[0] ?? pinned ?? candidates[0] ?? null;
}
