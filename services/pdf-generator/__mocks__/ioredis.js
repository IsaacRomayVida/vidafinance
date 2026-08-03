'use strict';

// Minimal ioredis stand-in. Never touches a real socket.
class IORedis {
  constructor() {
    this._listeners = {};
  }
  on(event, cb) {
    (this._listeners[event] = this._listeners[event] || []).push(cb);
    return this;
  }
  async ping() {
    return 'PONG';
  }
  async quit() {}
  disconnect() {}
}

module.exports = IORedis;
