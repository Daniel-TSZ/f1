import { Router } from 'express';
import { pool } from '../db';

const router = Router();

router.get('/', async (_req, res) => {
  const result = await pool.query('SELECT * FROM races ORDER BY race_date DESC');
  res.json(result.rows);
});

router.get('/:id', async (req, res) => {
  const race = await pool.query('SELECT * FROM races WHERE id = $1', [req.params.id]);
  if (!race.rows[0]) return res.status(404).json({ error: 'Событие не найдено' });

  const options = await pool.query(
    'SELECT * FROM bet_options WHERE race_id = $1 ORDER BY driver',
    [req.params.id]
  );

  const settings = await pool.query(
    `SELECT key, value FROM settings WHERE key IN
     ('coef_p1','coef_p2','coef_p3','coef_fastest_lap','coef_pole','coef_practice')`
  );
  const coefs: Record<string, number> = {};
  settings.rows.forEach(r => coefs[r.key] = parseFloat(r.value));

  res.json({ ...race.rows[0], options: options.rows, coefficients: coefs });
});

export default router;
