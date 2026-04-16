// Manual mock for the belvo SDK (not installed in test environment)
const mockClient = {
  connect: jest.fn().mockResolvedValue(undefined),
  links: {
    register: jest.fn().mockResolvedValue({ id: "mock-link-id" }),
    delete: jest.fn().mockResolvedValue(undefined),
  },
  employmentRecords: {
    retrieve: jest.fn().mockResolvedValue([]),
  },
  incomes: {
    retrieve: jest.fn().mockResolvedValue([]),
  },
};

const BelvoClient = jest.fn().mockImplementation(() => mockClient);

module.exports = { default: BelvoClient, __mockClient: mockClient };
