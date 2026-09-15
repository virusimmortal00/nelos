"use strict";

const blocked = () => {
  throw new Error("offline compatibility gate blocked a network operation");
};

for (const moduleName of ["node:http", "node:https"]) {
  const module = require(moduleName);
  module.request = blocked;
  module.get = blocked;
}

const net = require("node:net");
const { isAbsolute } = require("node:path");
// Permit only Unix sockets whose listeners were created by this same test
// process. TCP (including loopback), external local services and every other
// network entry point remain blocked. This is fixture IPC, not network access.
const ownedSockets = new Set();
function socketPath(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const path = typeof first === "string" ? first : first?.path;
  if (first && typeof first === "object" && (first.port !== undefined || first.host !== undefined)) return null;
  return typeof path === "string" && isAbsolute(path) ? path : null;
}
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const path = socketPath(args);
  if (path) {
    this.once("listening", () => ownedSockets.add(path));
    this.once("close", () => ownedSockets.delete(path));
  }
  return listen.apply(this, args);
};
for (const [object, key] of [[net, "connect"], [net, "createConnection"], [net.Socket.prototype, "connect"]]) {
  const connect = object[key];
  object[key] = function (...args) {
    if (!ownedSockets.has(socketPath(args))) return blocked();
    return connect.apply(this, args);
  };
}

const tls = require("node:tls");
tls.connect = blocked;
tls.TLSSocket.prototype.connect = blocked;

const dns = require("node:dns");
dns.lookup = blocked;
dns.resolve = blocked;
dns.resolve4 = blocked;
dns.resolve6 = blocked;
dns.promises.lookup = blocked;
dns.promises.resolve = blocked;
dns.promises.resolve4 = blocked;
dns.promises.resolve6 = blocked;

const dnsPromises = require("node:dns/promises");
dnsPromises.lookup = blocked;
dnsPromises.resolve = blocked;
dnsPromises.resolve4 = blocked;
dnsPromises.resolve6 = blocked;

const http2 = require("node:http2");
http2.connect = blocked;

const dgram = require("node:dgram");
dgram.createSocket = blocked;

globalThis.fetch = blocked;
