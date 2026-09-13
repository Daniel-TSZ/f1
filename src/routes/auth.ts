import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db';

const router = Router();

async function applyMonthlyBonus(userId: string): Promise<number> {
  const enabled = await pool.query("SELECT value FROM settings WHERE key='monthly_bonus_enabled'");
  if (enabled.rows[0]?.value !== '1') return 0;
  const bonusRes = await pool.query("SELECT value FROM settings WHERE key='monthly_bonus'");
  const bonus = parseInt(bonusRes.rows[0]?.value ?? '100', 10);

  const u = await pool.query('SELECT last_bonus_at FROM profiles WHERE id=$1', [userId]);
  const last = u.rows[0]?.last_bonus_at ? new Date(u.rows[0].last_bonus_at) : null;
  const now = new Date();
  if (last && last.getUTCFullYear() === now.getUTCFullYear() && last.getUTCMonth() === now.getUTCMonth()) {
    return 0;
  }
  await pool.query(
    'UPDATE profiles SET coins=coins+$1, last_bonus_at=NOW() WHERE id=$2',
    [bonus, userId]
  );
  await pool.query(
    `INSERT INTO transactions (user_id, amount, type, note)
     VALUES ($1,$2,'monthly','Ежемесячный бонус')`,
    [userId, bonus]
  );
  return bonus;
}

router.post('/register', async (req, res) => {
  const { nickname, password } = req.body;
  if (!nickname || !password) return res.status(400).json({ error: 'Ник и пароль обязательны' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO profiles (nickname, password_hash) VALUES ($1,$2)
       RETURNING id, nickname, coins`,
      [nickname, hash]
    );
    const user = result.rows[0];
    await pool.query(
      `INSERT INTO transactions (user_id, amount, type, note)
       VALUES ($1,200,'signup','Стартовый бонус')`,
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
  const result = await pool.query('SELECT * FROM profiles WHERE nickname=$1', [nickname]);
  const user = result.rows[0];
  if (!user) return res.status(400).json({ error: 'Пользователь не найден' });
  if (user.is_blocked) return res.status(403).json({ error: 'Заблокирован' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(400).json({ error: 'Неверный пароль' });

  const bonus = await applyMonthlyBonus(user.id);
  const fresh = await pool.query('SELECT id, nickname, coins FROM profiles WHERE id=$1', [user.id]);

  const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET as string);
  res.json({ token, user: fresh.rows[0], monthlyBonus: bonus });
});

export default router;
