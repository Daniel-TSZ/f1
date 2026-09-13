import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthRequest extends Request {
  userId?: string;
}

export function requireUser(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Нет токена' });
  try {
    const payload: any = jwt.verify(header.slice(7), process.env.JWT_SECRET as string);
    req.userId = payload.id;
    next();
  } catch {
    return res.status(401).json({ error: 'Токен неверный' });
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const pass = req.headers['x-admin-password'];
  if (pass !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Неверный пароль админа' });
  }
  next();
}
