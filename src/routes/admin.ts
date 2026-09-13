import { Router } from 'express';
import { pool } from '../db';
import { requireAdmin } from '../middleware/auth';

const router = Router();

router.post('/login', (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Неверный пароль' });
  }
  res.json({ ok: true });
});

router.use(requireAdmin);

// ---------- Гонки ----------
router.post('/races', async (req, res) => {
  const { name, circuit, raceDate, betDeadline, posterUrl } = req.body;
  const r = await pool.query(
    `INSERT INTO races (name, circuit, race_date, bet_deadline, poster_url)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [name, circuit, raceDate, betDeadline, posterUrl]
  );
  res.json(r.rows[0]);
});

router.patch('/races/:id', async (req, res) => {
  const { name, circuit, raceDate, betDeadline, posterUrl, status } = req.body;
  const r = await pool.query(
    `UPDATE races SET
       name = COALESCE($1, name),
       circuit = COALESCE($2, circuit),
       race_date = COALESCE($3, race_date),
       bet_deadline = COALESCE($4, bet_deadline),
       poster_url = COALESCE($5, poster_url),
       status = COALESCE($6, status)
     WHERE id = $7 RETURNING *`,
    [name, circuit, raceDate, betDeadline, posterUrl, status, req.params.id]
  );
  res.json(r.rows[0]);
});

router.delete('/races/:id', async (req, res) => {
  await pool.query('DELETE FROM races WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ---------- Варианты ставок ----------
router.post('/races/:id/options', async (req, res) => {
  const { type, driver, coefficient, isLocked } = req.body;
  let coef = coefficient;
  if (coef == null && type === 'winner') {
    coef = await calculateWinnerCoefficient(driver, req.params.id);
  }
  if (coef == null) coef = 2;

  const r = await pool.query(
    `INSERT INTO bet_options (race_id, type, driver, coefficient, is_locked)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [req.params.id, type, driver, coef, !!isLocked]
  );
  res.json(r.rows[0]);
});

router.patch('/options/:id', async (req, res) => {
  const { coefficient, isLocked } = req.body;
  const r = await pool.query(
    `UPDATE bet_options SET
       coefficient = COALESCE($1, coefficient),
       is_locked = COALESCE($2, is_locked)
     WHERE id = $3 RETURNING *`,
    [coefficient, isLocked, req.params.id]
  );
  res.json(r.rows[0]);
});

router.delete('/options/:id', async (req, res) => {
  await pool.query('DELETE FROM bet_options WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ---------- Результаты ----------
router.post('/races/:id/results', async (req, res) => {
  const { type, driver, position } = req.body;
  const r = await pool.query(
    `INSERT INTO results (race_id, type, driver, position)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [req.params.id, type, driver, position ?? null]
  );
  res.json(r.rows[0]);
});

router.delete('/results/:id', async (req, res) => {
  await pool.query('DELETE FROM results WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ---------- Выплаты ----------
router.post('/races/:id/payout', async (req, res) => {
  const raceId = req.params.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const results = await client.query(
      'SELECT type, driver FROM results WHERE race_id = $1',
      [raceId]
    );
    if (!results.rows.length) throw new Error('Нет результатов для этой гонки');

    const winningOptions = await client.query(
      `SELECT id FROM bet_options
       WHERE race_id = $1 AND (type, driver) IN (
         SELECT type, driver FROM results WHERE race_id = $1
       )`,
      [raceId]
    );
    const winIds = winningOptions.rows.map(r => r.id);

    // Проигравшие
    await client.query(
      `UPDATE bets SET status = 'lost'
       WHERE race_id = $1 AND status = 'pending'
         AND bet_option_id <> ALL($2::uuid[])`,
      [raceId, winIds.length ? winIds : ['00000000-0000-0000-0000-000000000000']]
    );

    // Победители
    if (winIds.length) {
      const winningBets = await client.query(
        `SELECT id, user_id, potential_payout FROM bets
         WHERE race_id = $1 AND status = 'pending' AND bet_option_id = ANY($2::uuid[])`,
        [raceId, winIds]
      );
      for (const bet of winningBets.rows) {
        await client.query('UPDATE bets SET status = $1 WHERE id = $2', ['won', bet.id]);
        await client.query(
          'UPDATE profiles SET coins = coins + $1 WHERE id = $2',
          [bet.potential_payout, bet.user_id]
        );
        await client.query(
          `INSERT INTO transactions (user_id, amount, type, note)
           VALUES ($1, $2, 'payout', 'Выигрыш по ставке')`,
          [bet.user_id, bet.potential_payout]
        );
      }
    }

    await client.query('UPDATE races SET status = $1 WHERE id = $2', ['finished', raceId]);
    await client.query(
      `INSERT INTO admin_log (action, details) VALUES ('payout', $1)`,
      [JSON.stringify({ raceId, winners: winIds.length })]
    );
    await client.query('COMMIT');
    res.json({ ok: true, paid: winIds.length });
  } catch (e: any) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ---------- Пользователи ----------
router.get('/users', async (_req, res) => {
  const r = await pool.query(
    `SELECT id, nickname, coins, is_blocked, created_at,
       (SELECT COALESCE(SUM(amount),0) FROM transactions
        WHERE user_id = profiles.id AND type = 'admin_gift'
          AND created_at >= date_trunc('month', NOW())) AS gifted_this_month
     FROM profiles ORDER BY coins DESC`
  );
  res.json(r.rows);
});

router.patch('/users/:id', async (req, res) => {
  const { isBlocked } = req.body;
  const r = await pool.query(
    `UPDATE profiles SET is_blocked = COALESCE($1, is_blocked)
     WHERE id = $2
     RETURNING id, nickname, coins, is_blocked`,
    [isBlocked, req.params.id]
  );
  res.json(r.rows[0]);
});

// ---------- Раздача монет (лимит 100 000 / месяц) ----------
router.post('/gift', async (req, res) => {
  const { userId, amount, note } = req.body;
  if (!userId || !amount || amount <= 0) {
    return res.status(400).json({ error: 'Неверные данные' });
  }

  const sumRes = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
     WHERE user_id = $1 AND type = 'admin_gift'
       AND created_at >= date_trunc('month', NOW())`,
    [userId]
  );
  const given = Number(sumRes.rows[0].total);
  if (given + amount > 100000) {
    return res.status(400).json({
      error: `Лимит 100000 в месяц. Уже выдано: ${given}`
    });
  }

  await pool.query('UPDATE profiles SET coins = coins + $1 WHERE id = $2', [amount, userId]);
  await pool.query(
    `INSERT INTO transactions (user_id, amount, type, note)
     VALUES ($1, $2, 'admin_gift', $3)`,
    [userId, amount, note || 'Подарок от админа']
  );
  await pool.query(
    `INSERT INTO admin_log (action, details) VALUES ('gift', $1)`,
    [JSON.stringify({ userId, amount })]
  );
  res.json({ ok: true });
});

// ---------- Автокоэффициент за серию побед ----------
async function calculateWinnerCoefficient(driver: string, currentRaceId: string): Promise<number> {
  const r = await pool.query(
    `SELECT res.driver
     FROM races r
     LEFT JOIN results res ON res.race_id = r.id AND res.type = 'winner'
     WHERE r.race_date < (SELECT race_date FROM races WHERE id = $1)
     ORDER BY r.race_date DESC
     LIMIT 5`,
    [currentRaceId]
  );
  let streak = 0;
  for (const row of r.rows) {
    if (row.driver === driver) streak++;
    else break;
  }
  if (streak < 2) return 10;
  return Math.max(10 - (streak - 1), 2);
}

export default router;
