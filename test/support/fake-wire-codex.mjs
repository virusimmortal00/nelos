#!/usr/bin/env node

const args = process.argv.slice(2);

// Node's repository-wide test discovery executes support modules directly.
// The fake becomes a process fixture only when an invocation is declared.
if (args.length === 0) {
  process.exit(0);
}

if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("codex-cli 0.144.6\n");
  process.exit(0);
}

if (
  args.length === 3 &&
  args[0] === "app-server" &&
  args[1] === "generate-json-schema" &&
  args[2] === "--experimental"
) {
  process.stdout.write(`${JSON.stringify({
    codexIdentity: { version: "0.144.6", commitSha: null },
    methods: {
      "thread/read": { readOnly: true },
      "thread/turns/list": { readOnly: true },
    },
  })}\n`);
  process.exit(0);
}

if (args.length !== 2 || args[0] !== "app-server" || args[1] !== "--stdio") {
  process.stderr.write("unexpected fake Codex invocation\n");
  process.exit(64);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    if (message.method === "initialize") {
      process.stdout.write(`${JSON.stringify({
        id: message.id,
        result: {
          codexHome: "/fake/codex-home",
          platformFamily: "unix",
          platformOs: "test",
          userAgent: "codex-cli/0.144.6",
        },
      })}\n`);
      continue;
    }
    if (message.method === "thread/list") {
      process.stdout.write(`${JSON.stringify({
        id: message.id,
        result: { data: [], nextCursor: null },
      })}\n`);
      continue;
    }
    process.stdout.write(`${JSON.stringify({
      id: message.id,
      error: {
        code: -32601,
        message: `undeclared fake operation ${message.method}`,
      },
    })}\n`);
  }
});
