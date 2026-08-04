'use strict';

// Minimal BullMQ stand-in -- no real Redis connection, no real scheduling.
// Queue.add just records calls; Worker captures its processor + 'failed'
// listeners so tests can invoke the disbursement logic directly, the same
// way BullMQ would invoke it when a job runs.

let failingCounts = new Map(); // queue name -> error message to throw on any getXCount()

class Queue {
  constructor(name) {
    this.name = name;
    this.addedJobs = [];
  }
  async add(name, data) {
    const job = { name, data };
    this.addedJobs.push(job);
    Queue.allAdded.push({ queue: this.name, ...job });
    return { id: `job_${Queue.allAdded.length}` };
  }
  _maybeFailCount() {
    if (failingCounts.has(this.name)) throw new Error(failingCounts.get(this.name));
  }
  async getWaitingCount() { this._maybeFailCount(); return 0; }
  async getActiveCount() { this._maybeFailCount(); return 0; }
  async getFailedCount() { this._maybeFailCount(); return 0; }
  async getCompletedCount() { this._maybeFailCount(); return 0; }
  async getDelayedCount() { this._maybeFailCount(); return 0; }
  async close() { Queue.closedNames.push(this.name); }
}
Queue.allAdded = [];
Queue.closedNames = [];
Queue.__reset = () => { Queue.allAdded = []; Queue.closedNames = []; failingCounts = new Map(); };
// Arm every getXCount() on the named queue to reject, simulating Redis being
// unreachable for that queue -- same shape as admin.__failAdds().
Queue.__failCounts = (name, message = 'Redis unavailable') => { failingCounts.set(name, message); };

class Worker {
  constructor(name, processor, opts) {
    this.name = name;
    this.processor = processor;
    this.opts = opts;
    this._listeners = {};
    Worker.instances.push(this);
  }
  on(event, cb) {
    (this._listeners[event] = this._listeners[event] || []).push(cb);
    return this;
  }
  async emit(event, ...args) {
    for (const cb of this._listeners[event] || []) await cb(...args);
  }
  async close() {}
}
Worker.instances = [];
Worker.__reset = () => { Worker.instances = []; };

module.exports = { Queue, Worker };
