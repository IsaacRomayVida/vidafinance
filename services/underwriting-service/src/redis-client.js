"use strict";
const IORedis = require("ioredis");

const redis = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  tls: process.env.REDIS_URL?.startsWith("rediss://")
    ? { rejectUnauthorized: false }
    : undefined,
});

module.exports = redis;
