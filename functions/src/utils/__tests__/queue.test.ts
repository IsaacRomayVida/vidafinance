/**
 * Regression tests for two defects in `utils/queue.ts`:
 *
 *  - No `defaultJobOptions`: every job shipped as `attempts: 1`, no backoff,
 *    and was never removed from Redis. Since PR #551 put real borrower
 *    loan-decision notifications on this queue, a single transient worker
 *    failure (Twilio 5xx, SendGrid 429) permanently dropped that borrower's
 *    notification with no retry.
 *  - `getQueue()` built a brand-new `Queue` (and therefore a brand-new
 *    ioredis connection) on every call, and nothing ever closed it. Called
 *    per-request inside a warm Cloud Functions container, this leaks one
 *    Redis connection per request for the life of the container.
 */
export {};

const mockQueueCtor = jest.fn();
jest.mock('bullmq', () => ({
  Queue: class {
    constructor(...args: unknown[]) {
      mockQueueCtor(...args);
    }
  },
}));

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
});

describe('utils/queue getQueue', () => {
  it('throws when REDIS_URL is not configured', async () => {
    delete process.env['REDIS_URL'];
    const { getQueue } = await import('../queue');
    expect(() => getQueue('vida-notifications')).toThrow('REDIS_URL not configured');
  });

  it('sets defaultJobOptions with retries, exponential backoff, and bounded retention', async () => {
    process.env['REDIS_URL'] = 'redis://localhost:6379';
    const { getQueue } = await import('../queue');

    getQueue('vida-notifications');

    expect(mockQueueCtor).toHaveBeenCalledTimes(1);
    const [name, opts] = mockQueueCtor.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe('vida-notifications');
    expect(opts['defaultJobOptions']).toEqual({
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    });

    delete process.env['REDIS_URL'];
  });

  it('memoizes one Queue instance per name instead of constructing a new one (and a new Redis connection) on every call', async () => {
    process.env['REDIS_URL'] = 'redis://localhost:6379';
    const { getQueue } = await import('../queue');

    const first = getQueue('vida-notifications');
    const second = getQueue('vida-notifications');
    const third = getQueue('vida-notifications');

    expect(mockQueueCtor).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(third).toBe(first);

    delete process.env['REDIS_URL'];
  });

  it('constructs a distinct, separately-memoized Queue per queue name', async () => {
    process.env['REDIS_URL'] = 'redis://localhost:6379';
    const { getQueue } = await import('../queue');

    const notifications = getQueue('vida-notifications');
    const pdfs = getQueue('vida-pdfs');

    expect(mockQueueCtor).toHaveBeenCalledTimes(2);
    expect(pdfs).not.toBe(notifications);

    delete process.env['REDIS_URL'];
  });
});
