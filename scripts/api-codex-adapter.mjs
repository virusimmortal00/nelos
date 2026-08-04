#!/usr/bin/env node

import { executeApiBaselineAttempt } from "../src/api-baseline-adapter.mjs";
import { claimApiOperation, recordApiProviderExchange, safeApiRuntimeError } from "../src/api-baseline-runtime.mjs";

async function requestFromStdin() { let text = ""; for await (const chunk of process.stdin) text += chunk; return JSON.parse(text); }

try {
  const request = await requestFromStdin();
  const ledgerRoot = process.env.NELOS_API_OPERATION_LEDGER;
  const exchangeLedgerRoot = process.env.NELOS_API_EXCHANGE_LEDGER;
  const response = await executeApiBaselineAttempt({ request, claimOperation: (value) => claimApiOperation(value, { ledgerRoot }), recordProviderExchange: (value) => recordApiProviderExchange(value, { ledgerRoot: exchangeLedgerRoot }) });
  process.stdout.write(JSON.stringify(response));
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: safeApiRuntimeError(error) })}\n`);
  process.exitCode = 1;
}
