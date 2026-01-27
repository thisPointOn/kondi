import { describe, it, expect, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { authMiddleware, createToken, hashPassword, verifyPassword } from '../server/lib/auth.js';

describe('auth helpers', () => {
  it('hashes and verifies passwords', async () => {
    const hashed = await hashPassword('secret');
    expect(hashed).not.toBe('secret');
    expect(await verifyPassword('secret', hashed)).toBe(true);
    expect(await verifyPassword('wrong', hashed)).toBe(false);
  });

  it('creates JWT with payload', () => {
    const token = createToken({ userId: 'u1', email: 'a@test.com' });
    const decoded = jwt.decode(token);
    expect((decoded as any).userId).toBe('u1');
  });

  it('authMiddleware passes valid token', async () => {
    const token = createToken({ userId: 'u1' });
    const req: any = { headers: { authorization: `Bearer ${token}` } };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    // @ts-ignore
    authMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user.userId).toBe('u1');
  });

  it('authMiddleware rejects missing token', () => {
    const req: any = { headers: {} };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    // @ts-ignore
    authMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
