import { getQueue } from './queue';

export type NotifyEventType =
  | 'loan_approved'
  | 'loan_disbursed'
  | 'loan_overdue'
  | 'employer_approved';

export interface NotifyPayload {
  phone?: string | null;
  email?: string | null;
  employeeName?: string;
  companyName?: string;
  amount?: number;
  dueDate?: string;
}

/**
 * Enqueue a notification for the given loan-lifecycle event.
 * Best-effort: failures are logged but never bubble up.
 */
export async function notifyLoanEvent(
  event: NotifyEventType,
  payload: NotifyPayload,
): Promise<void> {
  try {
    await getQueue('vida-notifications').add(event, {
      type: event,
      ...payload,
      queuedAt: new Date().toISOString(),
    });
  } catch (e: unknown) {
    console.warn(`notifyLoanEvent(${event}) queue unavailable:`, (e as Error).message);
  }
}
