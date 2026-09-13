import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();

import authRoutes from './routes/auth';
import racesRoutes from './routes/races';
import betsRoutes from './routes/bets';
import adminRoutes from './routes/admin';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/', (_req, res) => {
  res.json({ ok: true, name: 'F1 Bets API' });
});

app.use('/auth', authRoutes);
app.use('/races', racesRoutes);
app.use('/bets', betsRoutes);
app.use('/admin', adminRoutes);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
