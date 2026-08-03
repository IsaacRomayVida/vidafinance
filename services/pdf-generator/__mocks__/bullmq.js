'use strict';

// Minimal BullMQ stand-in -- no real Redis connection, no real scheduling.
// Queue.add just records calls; Worker captures its processor + 'failed'
// listeners so tests can invoke the disbursement logic directly, the same
// way BullMQ would invoke it when a job runs.

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
  async getWaitingCount() { return 0; }
  async getActiveCount() { return 0; }
  async getFailedCount() { return 0; }
  async getCompletedCount() { return 0; }
  async getDelayedCount() { return 0; }
  async close() {}
}
Queue.allAdded = [];
Queue.__reset = () => { Queue.allAdded = []; };

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
