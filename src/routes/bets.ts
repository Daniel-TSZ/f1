import { Router } from 'express';
import { pool } from '../db';
import { requireUser, AuthRequest } from '../middleware/auth';

const router = Router();

router.get('/my', requireUser, async (req: AuthRequest, res) => {
  const result = await pool.query(
    `SELECT b.*, r.name AS race_name, bo.driver, bo.type, bo.coefficient
     FROM bets b
     JOIN races r ON r.id = b.race_id
     JOIN bet_options bo ON bo.id = b.bet_option_id
     WHERE b.user_id = $1
     ORDER BY b.created_at DESC`,
    [req.userId]
  );
  res.json(result.rows);
});

router.post('/', requireUser, async (req: AuthRequest, res) => {
  const { raceId, betOptionId, amount } = req.body;
  if (!raceId || !betOptionId || !amount || amount <= 0) {
    return res.status(400).json({ error: 'Неверные данные' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userRes = await client.query(
      'SELECT coins FROM profiles WHERE id = $1 FOR UPDATE',
      [req.userId]
    );
    if (!userRes.rows[0]) throw new Error('Пользователь не найден');
    if (userRes.rows[0].coins < amount) throw new Error('Недостаточно монет');

    const raceRes = await client.query(
      'SELECT bet_deadline, status FROM races WHERE id = $1',
      [raceId]
    );
    const race = raceRes.rows[0];
    if (!race) throw new Error('Гонка не найдена');
    if (race.status === 'finished') throw new Error('Гонка завершена');
    if (race.bet_deadline && new Date(race.bet_deadline) < new Date()) {
      throw new Error('Дедлайн ставок прошёл');
    }

    const optRes = await client.query(
      'SELECT * FROM bet_options WHERE id = $1 AND race_id = $2',
      [betOptionId, raceId]
    );
    const opt = optRes.rows[0];
    if (!opt) throw new Error('Вариант не найден');
    if (opt.is_locked) throw new Error('Ставка на этого пилота закрыта');

    const payout = Math.floor(amount * Number(opt.coefficient));

    await client.query(
      'UPDATE profiles SET coins = coins - $1 WHERE id = $2',
      [amount, req.userId]
    );

    const betRes = await client.query(
      `INSERT INTO bets (user_id, race_id, bet_option_id, amount, potential_payout)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.userId, raceId, betOptionId, amount, payout]
    );

    await client.query(
      `INSERT INTO transactions (user_id, amount, type, note)
       VALUES ($1, $2, 'bet', $3)`,
      [req.userId, -amount, `Ставка: ${opt.driver} / ${opt.type}`]
    );

    await client.query('COMMIT');
    res.json(betRes.rows[0]);
  } catch (e: any) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

export default router;
