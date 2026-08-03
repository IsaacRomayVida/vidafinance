'use strict';

// Minimal @sendgrid/mail stand-in -- never touches the network.
const setApiKey = jest.fn();
const send = jest.fn().mockResolvedValue([{ statusCode: 202 }, {}]);

module.exports = { setApiKey, send };
