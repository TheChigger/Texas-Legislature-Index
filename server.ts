import 'dotenv/config';
import http from 'http';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { backfillBipartisanIndices, db, DB_PATH, dbExistedBeforeOpen, initSchema } from './src/server/db.ts';
import { seedAgencyRulesIfEmpty, seedDatabaseIfEmpty, seedSupplementalFiscalNotes } from './src/server/seed.ts';
import { backfillAllBillFiscalImpacts } from './src/server/fiscalParser.ts';
import { relinkAllRulesToBills } from './src/server/texasRegister.ts';
import { ensurePlatformsBootSynced } from './src/server/partyPlatforms.ts';
import { apiRouter } from './src/server/routes.ts';
import { cancelTloSyncJob, getLatestRunningTloSyncJob } from './src/server/tloFtp.ts';

async function startServer() {
  initSchema();
  seedDatabaseIfEmpty();
  seedSupplementalFiscalNotes();
  const bpBackfilled = backfillBipartisanIndices();
  if (bpBackfilled > 0) {
    console.log(`Computed bipartisan_index for ${bpBackfilled} indexed bill(s)`);
  }
  const fiscalBackfilled = backfillAllBillFiscalImpacts();
  if (fiscalBackfilled > 0) {
    console.log(`Parsed LBB fiscal impact for ${fiscalBackfilled} bill(s)`);
  }
  const rulesSeeded = seedAgencyRulesIfEmpty();
  const ruleLinks = relinkAllRulesToBills();
  if (rulesSeeded > 0 || ruleLinks > 0) {
    console.log(`Texas Register rules ready (${rulesSeeded} seeded, ${ruleLinks} bill link(s) created)`);
  }
  ensurePlatformsBootSynced();

  const app = express();
  const httpServer = http.createServer(app);
  const isAiStudioDevSandbox = Boolean(process.env.K_SERVICE && process.env.NODE_ENV !== 'production');
  const PORT = isAiStudioDevSandbox
    ? 3000
    : Number(process.env.CAPITOL_PORT || process.env.PORT || 3089);

  if (dbExistedBeforeOpen) {
    console.log(`Using existing SQLite database at ${DB_PATH}`);
  } else {
    console.log(`Initialized SQLite database at ${DB_PATH}`);
  }

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

  const shutdown = () => {
    try {
      const activeJob = getLatestRunningTloSyncJob();
      if (activeJob) cancelTloSyncJob(activeJob.id);
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    } catch {
      // Ignore shutdown close errors
    }
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Texas Capitol Ledger listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
