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
net.connect = blocked;
net.createConnection = blocked;
net.Socket.prototype.connect = blocked;

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
