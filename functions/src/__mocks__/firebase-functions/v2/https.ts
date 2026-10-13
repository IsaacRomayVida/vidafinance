export class HttpsError extends Error {
  // `details` is the third argument of the real class and reaches the client as `error.details`.
  constructor(public code: string, message: string, public details?: unknown) {
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
