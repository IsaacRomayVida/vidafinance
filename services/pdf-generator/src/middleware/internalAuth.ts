import { Request, Response, NextFunction } from 'express';

export function requireInternalSecret(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.INTERNAL_SECRET || process.env.INTERNAL_API_SECRET;
  if (!secret || req.headers['x-internal-secret'] !== secret) {
    res.status(401).json({ error: 'Unauthorized: invalid internal secret' });
    return;
  }
  next();
}
