import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db';

const router = Router();

router.post('/register', async (req, res) => {
  const { nickname, password } = req.body;
  if (!nickname || !password) {
    return res.status(400).json({ error: 'Ник и пароль обязательны' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO profiles (nickname, password_hash)
       VALUES ($1, $2)
       RETURNING id, nickname, coins`,
      [nickname, hash]
    );
    const user = result.rows[0];
    await pool.query(
      `INSERT INTO transactions (user_id, amount, type, note)
       VALUES ($1, 200, 'signup', 'Стартовый бонус')`,
      [user.id]
    );
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET as string);
    res.json({ token, user });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/login', async (req, res) => {
  const { nickname, password } = req.body;
  const result = await pool.query(
    'SELECT * FROM profiles WHERE nickname = $1',
    [nickname]
  );
  const user = result.rows[0];
  if (!user) return res.status(400).json({ error: 'Пользователь не найден' });
  if (user.is_blocked) return res.status(403).json({ error: 'Заблокирован' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(400).json({ error: 'Неверный пароль' });

  const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET as string);
  res.json({
    token,
    user: { id: user.id, nickname: user.nickname, coins: user.coins }
  });
});

export default router;
