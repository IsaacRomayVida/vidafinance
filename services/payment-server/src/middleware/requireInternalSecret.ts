import { Request, Response, NextFunction } from 'express';

/**
 * Middleware that guards /internal/* routes by checking the
 * x-internal-secret header against the INTERNAL_API_SECRET env var.
 */
export function requireInternalSecret(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    res.status(500).json({ error: 'Server misconfiguration: INTERNAL_API_SECRET not set' });
    return;
  }
  if (req.headers['x-internal-secret'] !== secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}
