import { Router } from 'express';
import { pool } from '../db';
import { requireUser, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(requireUser);

router.get('/', async (req: AuthRequest, res) => {
  const r = await pool.query(
    'SELECT id, nickname, coins, created_at FROM profiles WHERE id=$1',
    [req.userId]
  );
  res.json(r.rows[0]);
});

router.get('/transactions', async (req: AuthRequest, res) => {
  const r = await pool.query(
    'SELECT * FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',
    [req.userId]
  );
  res.json(r.rows);
});

router.get('/bets', async (req: AuthRequest, res) => {
  const r = await pool.query(
    `SELECT b.id, b.amount, b.potential_payout, b.status, b.created_at,
            r.id AS race_id, r.name AS race_name, r.race_date, r.status AS race_status,
            bo.driver, bo.type, bo.coefficient
     FROM bets b
     JOIN races r ON r.id=b.race_id
     JOIN bet_options bo ON bo.id=b.bet_option_id
     WHERE b.user_id=$1
     ORDER BY b.created_at DESC`,
    [req.userId]
  );
  res.json(r.rows);
});

export default router;
