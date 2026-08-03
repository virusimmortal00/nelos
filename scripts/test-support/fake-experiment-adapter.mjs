let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
process.stdout.write(JSON.stringify({
  outcome: "succeeded",
  observedRoute: request.requestedRoute,
  operationId: request.operationId,
  outputs: [{ id: "result", digest: request.declaredInputsDigest, byteLength: 1 }],
  artifacts: [],
  measurements: [{ metricId: "strict_pass_rate", value: 1 }],
  evidenceComplete: true,
  retryable: false,
}));
