import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

export function mockStdioAppServer(onRequest) {
  const requests = [];
  const children = [];
  const messages = new EventEmitter();
  return {
    requests,
    messages,
    children,
    spawnProcess() {
      const child = new EventEmitter();
      children.push(child);
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => { queueMicrotask(() => child.emit("exit", 0, "SIGTERM")); return true; };
      const send = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
      let buffer = "";
      child.stdin.setEncoding("utf8");
      child.stdin.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          requests.push(message);
          messages.emit("message", message);
          if (!Object.hasOwn(message, "id") || !Object.hasOwn(message, "method")) continue;
          Promise.resolve().then(() => onRequest(message, { send, child })).then(
            (result) => send({ id: message.id, result: result ?? {} }),
            (error) => send({ id: message.id, error: { code: error.rpcCode ?? -32603, message: error.message } }),
          );
        }
      });
      return child;
    },
  };
}
