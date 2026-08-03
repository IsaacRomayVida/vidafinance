'use strict';

// Minimal twilio SDK stand-in -- never touches the network. The real SDK
// throws on construction if accountSid doesn't look like "AC..."; this mock
// accepts anything so tests don't need valid-looking Twilio credentials.
const messagesCreate = jest.fn().mockResolvedValue({ sid: 'SM_mock' });

function twilio() {
  return {
    messages: { create: messagesCreate },
  };
}

twilio.__messagesCreate = messagesCreate;

module.exports = twilio;
