// Stub: integration tests don't make real HTTP calls
module.exports = jest.fn(() => Promise.reject(new Error('node-fetch is mocked in integration tests')));
module.exports.default = module.exports;
