import { z } from 'zod';
import { HttpsError } from 'firebase-functions/v2/https';

export function validateInput<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const message = result.error.issues
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((issue: any) => `${(issue.path as unknown[]).join('.') || 'input'}: ${issue.message as string}`)
      .join('; ');
    throw new HttpsError('invalid-argument', message);
  }
  return result.data;
}
