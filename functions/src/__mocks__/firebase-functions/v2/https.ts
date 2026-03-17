export class HttpsError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'HttpsError';
  }
}

// onCall just returns the handler as-is so tests can invoke it directly
export const onCall = jest.fn(
  (_options: unknown, handler: (req: unknown) => unknown) => handler
);
