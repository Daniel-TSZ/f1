import { Router } from 'express';
import { pool } from '../db';

const router = Router();

router.get('/', async (_req, res) => {
  const result = await pool.query(
    'SELECT * FROM races ORDER BY race_date DESC'
  );
  res.json(result.rows);
});

router.get('/:id', async (req, res) => {
  const race = await pool.query('SELECT * FROM races WHERE id = $1', [req.params.id]);
  if (!race.rows[0]) return res.status(404).json({ error: 'Гонка не найдена' });

  const options = await pool.query(
    'SELECT * FROM bet_options WHERE race_id = $1 ORDER BY type, driver',
    [req.params.id]
  );
  res.json({ ...race.rows[0], options: options.rows });
});

export default router;
