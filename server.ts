import 'dotenv/config';
import http from 'http';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { initSchema } from './src/server/db.ts';
import { seedDatabaseIfEmpty } from './src/server/seed.ts';
import { apiRouter } from './src/server/routes.ts';

async function startServer() {
  initSchema();
  seedDatabaseIfEmpty();

  const app = express();
  const httpServer = http.createServer(app);
  const PORT = 3000;

  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRouter);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Texas Capitol Ledger listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
