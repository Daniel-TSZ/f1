import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();

import authRoutes from './routes/auth';
import racesRoutes from './routes/races';
import betsRoutes from './routes/bets';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (_req, res) => {
  res.json({ ok: true, name: 'F1 Bets API' });
});

app.use('/auth', authRoutes);
app.use('/races', racesRoutes);
app.use('/bets', betsRoutes);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
