const pino = require('pino');

module.exports = (serviceName) => pino({
  name: serviceName,
  level: process.env.LOG_LEVEL || 'info',
  formatters: { level: (label) => ({ level: label }) },
});
