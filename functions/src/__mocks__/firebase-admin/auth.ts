export const mockSetCustomUserClaims = jest.fn(async () => {});

const mockAuth = {
  setCustomUserClaims: mockSetCustomUserClaims,
};

export const getAuth = jest.fn(() => mockAuth);
