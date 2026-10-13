import { buildContext } from './app.js';
import { loadEnv } from './config/env.js';
import { buildServer } from './http/server.js';
import { Scheduler } from './jobs/scheduler.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const ctx = await buildContext(env);
  const scheduler = new Scheduler(ctx);
  await scheduler.init();
  const app = await buildServer(ctx, scheduler, { webDir: process.env.WEB_DIR });
  await app.listen({ port: env.PORT, host: env.HOST });
  ctx.log.info(
    { port: env.PORT, dryRun: env.DRY_RUN, market: env.MARKET_ADAPTER, sources: ctx.sources.list().map((s) => s.id) },
    '서버 시작',
  );
  if (env.SCHEDULER_ENABLED) scheduler.start();

  const shutdown = async (sig: string) => {
    ctx.log.info({ sig }, '종료 중');
    scheduler.stop();
    await app.close();
    await ctx.db.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
