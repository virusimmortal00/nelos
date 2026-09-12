import { join } from "node:path";
import { lstat } from "node:fs/promises";
import { executorDigest, ExecutorContractError } from "./executor-contract.mjs";
import { readPrivateExecutorJsonV1 } from "./executor-service-channel.mjs";
const fail = (code) => { throw new ExecutorContractError(code); };
const read = async (path) => {
  try { await lstat(path); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  return readPrivateExecutorJsonV1(path);
};
export const claimPath = (store, id) => join(store.directory, "executor-claims", `${executorDigest(id)}.json`);
export async function readExecutorClaimV1(store, id) {
  // Custom legacy adapters may have no filesystem; they cannot be selected by
  // the installer, which always needs a durable store directory.
  if (typeof store.directory !== "string") return null;
  const claim = await read(claimPath(store, id));
  if (claim && (claim.workUnitId !== id || claim.backend !== "nelos-app-server" || !/^[a-f0-9]{64}$/u.test(claim.policyDigest))) fail("invalid-executor-claim");
  return claim;
}
