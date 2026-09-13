import { Router } from 'express';
import { pool } from '../db';
import { requireUser, AuthRequest } from '../middleware/auth';

const router = Router();

router.get('/my', requireUser, async (req: AuthRequest, res) => {
  const result = await pool.query(
    `SELECT b.*, r.name AS race_name, r.type AS race_type,
            bo.driver
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
  const { raceId, betOptionId, position, amount } = req.body;
  if (!raceId || !betOptionId || !position || !amount || amount < 10) {
    return res.status(400).json({ error: 'Неверные данные (минимум 10 монет)' });
  }

  const raceTypeRes = await pool.query('SELECT type FROM races WHERE id=$1', [raceId]);
  const raceType = raceTypeRes.rows[0]?.type;
  const allowed: Record<string, string[]> = {
    race: ['p1', 'p2', 'p3', 'fastest_lap'],
    quali: ['pole'],
    practice: ['best_practice']
  };
  if (!raceType || !allowed[raceType]?.includes(position)) {
    return res.status(400).json({ error: 'Эта позиция недоступна для такого события' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userRes = await client.query(
      'SELECT coins FROM profiles WHERE id=$1 FOR UPDATE',
      [req.userId]
    );
    if (userRes.rows[0].coins < amount) throw new Error('Недостаточно монет');

    const raceRes = await client.query(
      'SELECT bet_deadline, status FROM races WHERE id=$1',
      [raceId]
    );
    const race = raceRes.rows[0];
    if (race.status === 'finished') throw new Error('Событие завершено');
    if (race.bet_deadline && new Date(race.bet_deadline) < new Date()) {
      throw new Error('Дедлайн ставок прошёл');
    }

    const optRes = await client.query(
      'SELECT * FROM bet_options WHERE id=$1 AND race_id=$2',
      [betOptionId, raceId]
    );
    const opt = optRes.rows[0];
    if (!opt) throw new Error('Пилот не найден');
    if (opt.is_locked) throw new Error('Ставки на этого пилота закрыты');

    const dup = await client.query(
      'SELECT 1 FROM bets WHERE user_id=$1 AND race_id=$2 AND bet_option_id=$3 AND position=$4',
      [req.userId, raceId, betOptionId, position]
    );
    if (dup.rows.length) throw new Error('Ты уже ставил на этого пилота в этой позиции');

    const coefRes = await client.query('SELECT value FROM settings WHERE key=$1', ['coef_' + position]);
    let coef = parseFloat(coefRes.rows[0]?.value ?? '2');

    if (position === 'p1') {
      coef = await calculateWinnerCoefficient(opt.driver, raceId, client);
    }

    const payout = Math.floor(amount * coef);

    await client.query('UPDATE profiles SET coins=coins-$1 WHERE id=$2', [amount, req.userId]);
    const betRes = await client.query(
      `INSERT INTO bets (user_id, race_id, bet_option_id, position, amount, potential_payout)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.userId, raceId, betOptionId, position, amount, payout]
    );
    await client.query(
      `INSERT INTO transactions (user_id, amount, type, note)
       VALUES ($1,$2,'bet',$3)`,
      [req.userId, -amount, `Ставка: ${opt.driver} — ${positionName(position)}`]
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

function positionName(p: string): string {
  return {
    p1: '1 место', p2: '2 место', p3: '3 место',
    fastest_lap: 'Быстрый круг', pole: 'Поул', best_practice: 'Лучшее время'
  }[p] || p;
}

async function calculateWinnerCoefficient(
  driver: string,
  currentRaceId: string,
  client: any
): Promise<number> {
  const base = parseFloat((await client.query("SELECT value FROM settings WHERE key='coef_p1'")).rows[0]?.value ?? '10');
  const step = parseFloat((await client.query("SELECT value FROM settings WHERE key='coef_decrease_step'")).rows[0]?.value ?? '1');
  const min = parseFloat((await client.query("SELECT value FROM settings WHERE key='min_winner_coef'")).rows[0]?.value ?? '2');
  const threshold = parseInt((await client.query("SELECT value FROM settings WHERE key='streak_threshold'")).rows[0]?.value ?? '2', 10);

  const r = await client.query(
    `SELECT res.driver
     FROM races r
     LEFT JOIN results res ON res.race_id=r.id AND res.position='p1'
     WHERE r.race_date < (SELECT race_date FROM races WHERE id=$1)
       AND r.type='race'
     ORDER BY r.race_date DESC LIMIT 10`,
    [currentRaceId]
  );
  let streak = 0;
  for (const row of r.rows) {
    if (row.driver === driver) streak++;
    else break;
  }
  if (streak <= threshold) return base;
  return Math.max(base - (streak - threshold) * step, min);
}

export default router;
