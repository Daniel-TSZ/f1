import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();

import authRoutes from './routes/auth';
import racesRoutes from './routes/races';
import betsRoutes from './routes/bets';
import adminRoutes from './routes/admin';
import meRoutes from './routes/me';
import publicRoutes from './routes/public';

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
app.use('/me', meRoutes);
app.use('/public', publicRoutes);

// Глобальный обработчик ошибок — сервер не падает от одиночной ошибки
app.use((err: any, _req: any, res: any, _next: any) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Внутренняя ошибка' });
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
