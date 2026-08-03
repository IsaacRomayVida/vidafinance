'use strict';

// index.js requires node-fetch v2-style (default export is callable
// directly). jest.fn() lets each test configure a response via
// mockResolvedValueOnce / mockRejectedValueOnce.
module.exports = jest.fn();
