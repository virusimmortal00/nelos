import { createHash } from "node:crypto";
import net from "node:net";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeServerFrame(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  let header;

  if (payload.length <= 125) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  return Buffer.concat([header, payload]);
}

export async function startMockAppServer(socketPath, onRequest = async () => ({})) {
  const requests = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let upgraded = false;
    let buffer = Buffer.alloc(0);

    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});

    const dispatch = async (message) => {
      requests.push(message);
      if (!("id" in message)) return;

      try {
        const result = await onRequest(message);
        if (!socket.destroyed) {
          socket.write(encodeServerFrame({ id: message.id, result: result ?? {} }));
        }
      } catch (error) {
        if (!socket.destroyed) {
          socket.write(
            encodeServerFrame({
              id: message.id,
              error: { message: error.message },
            }),
          );
        }
      }
    };

    const consumeFrames = () => {
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let payloadLength = buffer[1] & 0x7f;
        let offset = 2;

        if (payloadLength === 126) {
          if (buffer.length < offset + 2) return;
          payloadLength = buffer.readUInt16BE(offset);
          offset += 2;
        } else if (payloadLength === 127) {
          if (buffer.length < offset + 8) return;
          payloadLength = Number(buffer.readBigUInt64BE(offset));
          offset += 8;
        }

        const maskLength = masked ? 4 : 0;
        const frameLength = offset + maskLength + payloadLength;
        if (buffer.length < frameLength) return;

        const mask = masked ? buffer.subarray(offset, offset + 4) : null;
        offset += maskLength;
        const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
        buffer = buffer.subarray(frameLength);

        if (mask) {
          for (let index = 0; index < payload.length; index += 1) {
            payload[index] ^= mask[index % mask.length];
          }
        }

        if (opcode === 0x8) {
          socket.end();
          continue;
        }
        if (opcode !== 0x1) continue;
        void dispatch(JSON.parse(payload.toString("utf8")));
      }
    };

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;

        const headerText = buffer.subarray(0, headerEnd).toString("utf8");
        const key = headerText.match(/^Sec-WebSocket-Key:\s*(.+)$/im)?.[1]?.trim();
        if (!key) {
          socket.destroy(new Error("missing WebSocket key"));
          return;
        }
        const accept = createHash("sha1")
          .update(key + WEBSOCKET_GUID)
          .digest("base64");
        socket.write(
          [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Accept: ${accept}`,
            "",
            "",
          ].join("\r\n"),
        );
        buffer = buffer.subarray(headerEnd + 4);
        upgraded = true;
      }
      consumeFrames();
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  return {
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
