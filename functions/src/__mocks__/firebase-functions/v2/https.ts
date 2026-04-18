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

// onRequest returns the handler as-is. Supports both (options, handler) and (handler) forms.
export const onRequest = jest.fn((...args: unknown[]) => {
  if (args.length === 1 && typeof args[0] === 'function') return args[0];
  return args[1];
});
