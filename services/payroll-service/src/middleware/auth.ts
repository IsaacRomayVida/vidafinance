import { Request, Response, NextFunction } from 'express';

export function internalAuth(req: Request, res: Response, next: NextFunction): void {
  const secret = req.headers['x-internal-secret'];
  if (!secret || secret !== process.env.INTERNAL_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}
