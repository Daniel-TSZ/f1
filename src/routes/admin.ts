import { Router } from 'express';
import { pool } from '../db';
import { requireAdmin } from '../middleware/auth';

const router = Router();

async function getSetting(key: string, fallback: string): Promise<string> {
  const r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  return r.rows[0]?.value ?? fallback;
}

router.post('/login', (req, res) => {
  if (req.body.password !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Неверный пароль' });
  res.json({ ok: true });
});

router.use(requireAdmin);

// ==================== DASHBOARD ====================
router.get('/dashboard', async (_req, res) => {
  const [users, races, bets, coins, pending] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS c FROM profiles'),
    pool.query('SELECT COUNT(*)::int AS c FROM races'),
    pool.query('SELECT COUNT(*)::int AS c FROM bets'),
    pool.query('SELECT COALESCE(SUM(coins),0)::int AS c FROM profiles'),
    pool.query(`SELECT COALESCE(SUM(potential_payout),0)::int AS c FROM bets WHERE status='pending'`)
  ]);
  const top = await pool.query('SELECT nickname, coins FROM profiles ORDER BY coins DESC LIMIT 5');
  res.json({
    users: users.rows[0].c, races: races.rows[0].c, bets: bets.rows[0].c,
    coinsInSystem: coins.rows[0].c, pendingPayouts: pending.rows[0].c,
    top: top.rows
  });
});

// ==================== SETTINGS ====================
router.get('/settings', async (_req, res) => {
  const r = await pool.query('SELECT key, value FROM settings');
  const obj: Record<string, string> = {};
  r.rows.forEach(row => obj[row.key] = row.value);
  res.json(obj);
});

router.patch('/settings', async (req, res) => {
  const updates = req.body as Record<string, string>;
  const keys = Object.keys(updates);
  if (!keys.length) return res.json({ ok: true });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const k of keys) {
      await client.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [k, String(updates[k])]
      );
    }
    await client.query(
      `INSERT INTO admin_log (action, details) VALUES ('settings_update', $1)`,
      [JSON.stringify(updates)]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e: any) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally { client.release(); }
});

// ==================== LOGS ====================
router.get('/logs', async (_req, res) => {
  const r = await pool.query('SELECT * FROM admin_log ORDER BY created_at DESC LIMIT 100');
  res.json(r.rows);
});

// ==================== RACES ====================
router.post('/races', async (req, res) => {
  const { name, circuit, raceDate, betDeadline, posterUrl, type } = req.body;
  const r = await pool.query(
    `INSERT INTO races (name, circuit, race_date, bet_deadline, poster_url, type)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [name, circuit, raceDate, betDeadline, posterUrl, type || 'race']
  );
  res.json(r.rows[0]);
});

router.patch('/races/:id', async (req, res) => {
  const { name, circuit, raceDate, betDeadline, posterUrl, status, type } = req.body;
  const r = await pool.query(
    `UPDATE races SET
       name=COALESCE($1,name), circuit=COALESCE($2,circuit),
       race_date=COALESCE($3,race_date), bet_deadline=COALESCE($4,bet_deadline),
       poster_url=COALESCE($5,poster_url), status=COALESCE($6,status),
       type=COALESCE($7,type)
     WHERE id=$8 RETURNING *`,
    [name, circuit, raceDate, betDeadline, posterUrl, status, type, req.params.id]
  );
  res.json(r.rows[0]);
});

router.delete('/races/:id', async (req, res) => {
  await pool.query('DELETE FROM races WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

router.post('/races/:id/duplicate', async (req, res) => {
  const src = await pool.query('SELECT * FROM races WHERE id=$1', [req.params.id]);
  if (!src.rows[0]) return res.status(404).json({ error: 'Не найдено' });
  const r = src.rows[0];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const newRace = await client.query(
      `INSERT INTO races (name, circuit, race_date, bet_deadline, poster_url, type, status)
       VALUES ($1,$2,$3,$4,$5,$6,'upcoming') RETURNING *`,
      [`${r.name} (копия)`, r.circuit, r.race_date, r.bet_deadline, r.poster_url, r.type]
    );
    const newId = newRace.rows[0].id;
    const opts = await client.query('SELECT * FROM bet_options WHERE race_id=$1', [req.params.id]);
    for (const o of opts.rows) {
      await client.query(
        'INSERT INTO bet_options (race_id, driver, is_locked) VALUES ($1,$2,false)',
        [newId, o.driver]
      );
    }
    await client.query('COMMIT');
    res.json(newRace.rows[0]);
  } catch (e: any) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally { client.release(); }
});

// ==================== BET OPTIONS (пилоты) ====================
router.post('/races/:id/options', async (req, res) => {
  const { driver, isLocked } = req.body;
  if (!driver) return res.status(400).json({ error: 'Имя пилота пусто' });
  const r = await pool.query(
    'INSERT INTO bet_options (race_id, driver, is_locked) VALUES ($1,$2,$3) RETURNING *',
    [req.params.id, driver, !!isLocked]
  );
  res.json(r.rows[0]);
});

router.post('/races/:id/options/bulk', async (req, res) => {
  const { drivers } = req.body as { drivers: string[] };
  if (!Array.isArray(drivers) || !drivers.length)
    return res.status(400).json({ error: 'Список пуст' });
  const client = await pool.connect();
  let added = 0;
  try {
    await client.query('BEGIN');
    for (const d of drivers) {
      const t = String(d).trim();
      if (!t) continue;
      await client.query(
        'INSERT INTO bet_options (race_id, driver) VALUES ($1,$2)',
        [req.params.id, t]
      );
      added++;
    }
    await client.query('COMMIT');
    res.json({ ok: true, added });
  } catch (e: any) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally { client.release(); }
});

router.patch('/options/:id', async (req, res) => {
  const { isLocked, driver } = req.body;
  const r = await pool.query(
    `UPDATE bet_options SET
       is_locked=COALESCE($1,is_locked),
       driver=COALESCE($2,driver)
     WHERE id=$3 RETURNING *`,
    [isLocked, driver, req.params.id]
  );
  res.json(r.rows[0]);
});

router.delete('/options/:id', async (req, res) => {
  await pool.query('DELETE FROM bet_options WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

router.post('/races/:id/options/lock-all', async (req, res) => {
  await pool.query('UPDATE bet_options SET is_locked=$1 WHERE race_id=$2', [!!req.body.lock, req.params.id]);
  res.json({ ok: true });
});

// ==================== RESULTS ====================
router.get('/races/:id/results', async (req, res) => {
  const r = await pool.query('SELECT * FROM results WHERE race_id=$1', [req.params.id]);
  res.json(r.rows);
});

router.post('/races/:id/results', async (req, res) => {
  const { position, driver } = req.body;
  if (!position || !driver) return res.status(400).json({ error: 'Позиция и пилот обязательны' });
  const r = await pool.query(
    'INSERT INTO results (race_id, position, driver) VALUES ($1,$2,$3) RETURNING *',
    [req.params.id, position, driver]
  );
  res.json(r.rows[0]);
});

router.delete('/results/:id', async (req, res) => {
  await pool.query('DELETE FROM results WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ==================== BETS ====================
router.get('/races/:id/bets', async (req, res) => {
  const r = await pool.query(
    `SELECT b.*, p.nickname, bo.driver
     FROM bets b
     JOIN profiles p ON p.id=b.user_id
     JOIN bet_options bo ON bo.id=b.bet_option_id
     WHERE b.race_id=$1 ORDER BY b.created_at DESC`,
    [req.params.id]
  );
  res.json(r.rows);
});

router.get('/users/:id/bets', async (req, res) => {
  const r = await pool.query(
    `SELECT b.*, r.name AS race_name, bo.driver
     FROM bets b
     JOIN races r ON r.id=b.race_id
     JOIN bet_options bo ON bo.id=b.bet_option_id
     WHERE b.user_id=$1 ORDER BY b.created_at DESC LIMIT 100`,
    [req.params.id]
  );
  res.json(r.rows);
});

router.get('/users/:id/transactions', async (req, res) => {
  const r = await pool.query(
    'SELECT * FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',
    [req.params.id]
  );
  res.json(r.rows);
});

// ==================== PAYOUT / REVERT ====================
router.post('/races/:id/payout', async (req, res) => {
  const raceId = req.params.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const results = await client.query(
      'SELECT position, driver FROM results WHERE race_id=$1', [raceId]
    );
    if (!results.rows.length) throw new Error('Нет результатов');

    // Находим выигрышные bet_options
    const winners = await client.query(
      `SELECT DISTINCT bo.id
       FROM bet_options bo
       JOIN results res ON res.race_id=bo.race_id AND res.driver=bo.driver
       WHERE bo.race_id=$1`,
      [raceId]
    );
    const winnerIds = winners.rows.map(r => r.id);

    // Проигравшие (у которых нет выигрышного сочетания пилот+позиция)
    await client.query(
      `UPDATE bets SET status='lost'
       WHERE race_id=$1 AND status='pending'
         AND NOT EXISTS (
           SELECT 1 FROM results res
           WHERE res.race_id=bets.race_id
             AND res.driver=(SELECT driver FROM bet_options WHERE id=bets.bet_option_id)
             AND res.position=bets.position
         )`,
      [raceId]
    );

    // Победители
    const winningBets = await client.query(
      `SELECT b.id, b.user_id, b.potential_payout FROM bets b
       WHERE b.race_id=$1 AND b.status='pending'
         AND EXISTS (
           SELECT 1 FROM results res
           WHERE res.race_id=b.race_id
             AND res.driver=(SELECT driver FROM bet_options WHERE id=b.bet_option_id)
             AND res.position=b.position
         )`,
      [raceId]
    );

    let paid = 0;
    for (const bet of winningBets.rows) {
      await client.query("UPDATE bets SET status='won' WHERE id=$1", [bet.id]);
      await client.query('UPDATE profiles SET coins=coins+$1 WHERE id=$2', [bet.potential_payout, bet.user_id]);
      await client.query(
        `INSERT INTO transactions (user_id, amount, type, note)
         VALUES ($1,$2,'payout','Выигрыш по ставке')`,
        [bet.user_id, bet.potential_payout]
      );
      paid++;
    }

    await client.query("UPDATE races SET status='finished' WHERE id=$1", [raceId]);
    await client.query(
      `INSERT INTO admin_log (action, details) VALUES ('payout', $1)`,
      [JSON.stringify({ raceId, paid })]
    );
    await client.query('COMMIT');
    res.json({ ok: true, paid });
  } catch (e: any) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally { client.release(); }
});

router.post('/races/:id/revert-payout', async (req, res) => {
  const raceId = req.params.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const won = await client.query(
      "SELECT id, user_id, potential_payout FROM bets WHERE race_id=$1 AND status='won'",
      [raceId]
    );
    for (const bet of won.rows) {
      await client.query(
        'UPDATE profiles SET coins=GREATEST(coins-$1, 0) WHERE id=$2',
        [bet.potential_payout, bet.user_id]
      );
    }
    await client.query(
      "DELETE FROM transactions WHERE user_id IN (SELECT user_id FROM bets WHERE race_id=$1 AND status='won') AND type='payout'",
      [raceId]
    );
    await client.query("UPDATE bets SET status='pending' WHERE race_id=$1", [raceId]);
    await client.query("UPDATE races SET status='closed' WHERE id=$1", [raceId]);
    await client.query('COMMIT');
    res.json({ ok: true, reverted: won.rows.length });
  } catch (e: any) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally { client.release(); }
});

// ==================== USERS ====================
router.get('/users', async (_req, res) => {
  const r = await pool.query(
    `SELECT id, nickname, coins, is_blocked, created_at,
       (SELECT COALESCE(SUM(amount),0) FROM transactions
        WHERE user_id=profiles.id AND type='admin_gift'
          AND created_at >= date_trunc('month', NOW())) AS gifted_this_month
     FROM profiles ORDER BY coins DESC`
  );
  res.json(r.rows);
});

router.post('/users', async (req, res) => {
  const { nickname, password } = req.body;
  if (!nickname || !password) return res.status(400).json({ error: 'Заполни поля' });
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash(password, 10);
  try {
    const r = await pool.query(
      `INSERT INTO profiles (nickname, password_hash) VALUES ($1,$2)
       RETURNING id, nickname, coins`,
      [nickname, hash]
    );
    await pool.query(
      `INSERT INTO transactions (user_id, amount, type, note)
       VALUES ($1, 200, 'signup', 'Стартовый бонус')`,
      [r.rows[0].id]
    );
    res.json(r.rows[0]);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.patch('/users/:id', async (req, res) => {
  const { isBlocked, nickname } = req.body;
  const r = await pool.query(
    `UPDATE profiles SET
       is_blocked=COALESCE($1,is_blocked), nickname=COALESCE($2,nickname)
     WHERE id=$3 RETURNING id, nickname, coins, is_blocked`,
    [isBlocked, nickname, req.params.id]
  );
  res.json(r.rows[0]);
});

router.delete('/users/:id', async (req, res) => {
  await pool.query('DELETE FROM profiles WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

router.post('/users/:id/reset-password', async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword) return res.status(400).json({ error: 'Пароль пуст' });
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE profiles SET password_hash=$1 WHERE id=$2', [hash, req.params.id]);
  res.json({ ok: true });
});

// ==================== GIFTS ====================
router.post('/gift', async (req, res) => {
  const { userId, amount, note } = req.body;
  if (!userId || !amount || amount <= 0) return res.status(400).json({ error: 'Неверно' });
  const limit = parseInt(await getSetting('monthly_gift_limit', '100000'), 10);
  const sumRes = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS total FROM transactions
     WHERE user_id=$1 AND type='admin_gift' AND created_at >= date_trunc('month', NOW())`,
    [userId]
  );
  const given = Number(sumRes.rows[0].total);
  if (given + amount > limit)
    return res.status(400).json({ error: `Лимит ${limit}. Уже выдано: ${given}` });

  await pool.query('UPDATE profiles SET coins=coins+$1 WHERE id=$2', [amount, userId]);
  await pool.query(
    `INSERT INTO transactions (user_id, amount, type, note) VALUES ($1,$2,'admin_gift',$3)`,
    [userId, amount, note || 'Подарок от админа']
  );
  await pool.query(
    `INSERT INTO admin_log (action, details) VALUES ('gift', $1)`,
    [JSON.stringify({ userId, amount })]
  );
  res.json({ ok: true });
});

export default router;
