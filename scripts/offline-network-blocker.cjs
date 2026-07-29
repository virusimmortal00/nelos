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

const tls = require("node:tls");
tls.connect = blocked;

const dns = require("node:dns");
dns.lookup = blocked;
dns.resolve = blocked;
dns.resolve4 = blocked;
dns.resolve6 = blocked;

globalThis.fetch = blocked;
