import { Router } from 'express';
import { pool } from '../db';

const router = Router();

router.get('/leaderboard', async (_req, res) => {
  const r = await pool.query(
    'SELECT nickname, coins FROM profiles WHERE is_blocked=false ORDER BY coins DESC LIMIT 100'
  );
  res.json(r.rows);
});

export default router;
