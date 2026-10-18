'use strict';
// Loaded with --require only in the managed engine, never inherited via NODE_OPTIONS.
const http = require('node:http');
const path = require('node:path');
const original = http.Server.prototype.listen;
const socketPath = path.join(__dirname, 'engine-private.sock');
http.Server.prototype.listen = function (...args) {
  const first = args[0];
  const port = first && typeof first === 'object' ? first.port : first;
  if (Number(port) !== 3080) return original.apply(this, args);
  const callback = typeof args.at(-1) === 'function' ? args.at(-1) : undefined;
  // Keep the engine's advertised origin (auth cookie authority, URLs, Host checks) stable.
  const address = this.address;
  this.address = function () {
    const actual = address.call(this);
    return actual === socketPath ? { address: '127.0.0.1', family: 'IPv4', port: 3080 } : actual;
  };
  return callback ? original.call(this, socketPath, callback) : original.call(this, socketPath);
};
