import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const jwtSecret = process.env.JWT_SECRET || 'dev-secret';

export const hashPassword = async (password) => bcrypt.hash(password, 10);
export const verifyPassword = async (password, hash) => bcrypt.compare(password, hash);

export const createToken = (payload) =>
  jwt.sign(payload, jwtSecret, { expiresIn: '7d' });

export const authMiddleware = (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    const decoded = jwt.verify(token, jwtSecret);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }
};
