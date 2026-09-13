import { Router } from 'express';
import { pool } from '../db';

const router = Router();

router.get('/my/:userId', async (req, res) => {
  const result = await pool.query(
    `SELECT b.*, r.name AS race_name, bo.driver, bo.type
     FROM bets b
     JOIN races r ON r.id = b.race_id
     JOIN bet_options bo ON bo.id = b.bet_option_id
     WHERE b.user_id = $1
     ORDER BY b.created_at DESC`,
    [req.params.userId]
  );
  res.json(result.rows);
});

export default router;
