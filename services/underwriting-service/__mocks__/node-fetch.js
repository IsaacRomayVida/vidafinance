// Manual mock for node-fetch (not installed in test environment)
const mockFetch = jest.fn();
module.exports = mockFetch;
