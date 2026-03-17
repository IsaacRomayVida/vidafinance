import { Router, Request, Response } from 'express';
import { FirestoreService } from '../services/firestoreService';

const firestore = new FirestoreService();

export const webhooksRouter = Router();

/**
 * POST /webhooks/twilio/status
 * Twilio delivery status callback. Updates notification_log with delivery status.
 * Twilio sends: MessageSid, MessageStatus, To, From, ErrorCode (optional)
 */
webhooksRouter.post('/twilio/status', async (req: Request, res: Response) => {
  const { MessageSid, MessageStatus, ErrorCode } = req.body;

  if (!MessageSid || !MessageStatus) {
    res.status(400).json({ error: 'Missing MessageSid or MessageStatus' });
    return;
  }

  console.log(`[webhook] Twilio status: ${MessageSid} → ${MessageStatus}${ErrorCode ? ` (error: ${ErrorCode})` : ''}`);

  try {
    await firestore.updateNotificationStatus('twilio', MessageSid, MessageStatus);
  } catch (err) {
    console.error(`[webhook] Failed to update notification status:`, (err as Error).message);
  }

  // Always respond 200 to Twilio to avoid retries
  res.sendStatus(200);
});
