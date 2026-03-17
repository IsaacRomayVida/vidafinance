const pushed: Array<[string, string]> = [];

export const redis = {
  ping: jest.fn(async () => 'PONG'),
  lpush: jest.fn(async (key: string, value: string) => {
    pushed.push([key, value]);
    return pushed.length;
  }),
  lPush: jest.fn(async (key: string, value: string) => {
    pushed.push([key, value]);
    return pushed.length;
  }),
  brpop: jest.fn(async () => null),
};

export function __getPushed(): Array<[string, string]> {
  return pushed;
}

export function __resetPushed(): void {
  pushed.length = 0;
}
