import type { Settings } from '../config/settings.js';
import type { AppContext } from '../context.js';
import { errMessage, kstDate, kstHour } from '../lib/util.js';
import { pollInquiries } from '../modules/cs/service.js';
import { reconcile } from '../modules/finance/service.js';
import { refreshListingStatuses } from '../modules/listing/service.js';
import { checkDelays, pollClaims, pollFulfillment, pollNewOrders, processPending, purgePii } from '../modules/orders/service.js';
import { sendDailyReport, watchdog } from '../modules/reports/service.js';
import { runSelection } from '../modules/selection/service.js';
import { syncShippingPlaces } from '../modules/setup/coupangPlaces.js';
import { safetyCheck } from '../modules/guard/safety.js';
import { discoverKeywords } from '../modules/keywords/service.js';
import { optimizePrices, reviewSlowListings, scoutCheaperSources, syncListings } from '../modules/sync/service.js';

/**
 * 내장 스케줄러. 작업 추가는 JOBS 배열에 한 줄.
 * - 같은 작업은 동시에 한 번만 실행
 * - 실행 이력은 job_runs 에 기록(관리자 웹에서 확인)
 * - 주기는 settings.schedule 에서 조정
 */
export interface JobDef {
  name: string;
  label: string;
  /** 다음 실행까지 간격(ms). null 이면 시각 기반(due 함수) */
  intervalMs: (s: Settings) => number | null;
  due?: (ctx: AppContext, s: Settings, lastStarted: Date | null) => boolean;
  run: (ctx: AppContext) => Promise<unknown>;
}

const min = (m: number) => m * 60_000;

export const JOBS: JobDef[] = [
  {
    name: 'orders.poll', label: '주문 수집·처리',
    intervalMs: (s) => min(s.schedule.orderPollMinutes),
    run: async (ctx) => ({ poll: await pollNewOrders(ctx), process: await processPending(ctx), claims: await pollClaims(ctx) }),
  },
  {
    name: 'orders.fulfillment', label: '송장 회수·배송 추적',
    intervalMs: (s) => min(s.schedule.fulfillmentMinutes),
    run: async (ctx) => ({ fulfillment: await pollFulfillment(ctx), delays: await checkDelays(ctx) }),
  },
  { name: 'listings.status', label: '상품 승인 상태', intervalMs: (s) => min(s.schedule.listingStatusMinutes), run: refreshListingStatuses },
  {
    name: 'listings.sync', label: '가격·재고 동기화',
    intervalMs: (s) => min(s.schedule.syncMinutes),
    run: async (ctx) => ({ sync: await syncListings(ctx), slow: await reviewSlowListings(ctx) }),
  },
  {
    name: 'profit.optimize', label: '수익 최적화(가격·원가)',
    intervalMs: () => 24 * 3600_000,
    run: async (ctx) => ({ prices: await optimizePrices(ctx), cost: await scoutCheaperSources(ctx) }),
  },
  { name: 'cs.poll', label: '고객문의', intervalMs: (s) => min(s.schedule.csMinutes), run: pollInquiries },
  { name: 'finance.reconcile', label: '정산 대사', intervalMs: (s) => s.schedule.reconcileHours * 3600_000, run: async (ctx) => ({ reconcile: await reconcile(ctx), pii: await purgePii(ctx) }) },
  { name: 'keywords.discover', label: '키워드 자동 발굴', intervalMs: (s) => s.schedule.discoveryHours * 3600_000, run: discoverKeywords },
  { name: 'selection.run', label: '상품 선정', intervalMs: (s) => s.schedule.selectionHours * 3600_000, run: (ctx) => runSelection(ctx) },
  {
    name: 'report.daily', label: '일일 리포트',
    intervalMs: () => null,
    due: (ctx, s, last) => {
      const now = ctx.clock.now();
      return kstHour(now) >= s.schedule.dailyReportHour && (!last || kstDate(last) !== kstDate(now));
    },
    run: sendDailyReport,
  },
  { name: 'setup.coupangPlaces', label: '쿠팡 출고지·반품지 자동 설정', intervalMs: () => 6 * 3600_000, run: syncShippingPlaces },
  {
    name: 'watchdog', label: '감시·안전장치(문제 감지 → 자동 판매 중지)',
    intervalMs: (s) => min(s.schedule.watchdogMinutes),
    run: async (ctx) => ({ watchdog: await watchdog(ctx), safety: await safetyCheck(ctx) }),
  },
];

export class Scheduler {
  private running = new Set<string>();
  private timer?: NodeJS.Timeout;
  private lastStarted = new Map<string, Date>();

  constructor(private readonly ctx: AppContext, private readonly jobs: JobDef[] = JOBS) {}

  async init(): Promise<void> {
    for (const j of this.jobs) {
      const r = await this.ctx.db.selectFrom('job_runs').select('started_at').where('job', '=', j.name).orderBy('started_at', 'desc').executeTakeFirst();
      if (r) this.lastStarted.set(j.name, new Date(r.started_at));
    }
  }

  start(tickMs = 30_000): void {
    this.timer = setInterval(() => void this.tick(), tickMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    const s = await this.ctx.settings.get();
    const now = this.ctx.clock.now();
    for (const j of this.jobs) {
      if (this.running.has(j.name)) continue;
      const last = this.lastStarted.get(j.name) ?? null;
      const interval = j.intervalMs(s);
      const isDue = interval !== null ? !last || now.getTime() - last.getTime() >= interval : (j.due?.(this.ctx, s, last) ?? false);
      if (isDue) void this.runJob(j.name);
    }
  }

  /** 수동 실행(관리자 웹) 또는 스케줄 실행 */
  async runJob(name: string): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const j = this.jobs.find((x) => x.name === name);
    if (!j) return { ok: false, error: `없는 작업: ${name}` };
    if (this.running.has(name)) return { ok: false, error: '이미 실행 중' };
    this.running.add(name);
    const started = this.ctx.clock.now();
    this.lastStarted.set(name, started);
    const run = await this.ctx.db.insertInto('job_runs').values({ job: name, started_at: started }).returning('id').executeTakeFirstOrThrow();
    try {
      const result = await j.run(this.ctx);
      await this.ctx.db.updateTable('job_runs').set({ finished_at: this.ctx.clock.now(), ok: true, stats: JSON.stringify(result ?? null) }).where('id', '=', run.id).execute();
      return { ok: true, result };
    } catch (e) {
      const msg = errMessage(e);
      this.ctx.log.error({ job: name, err: msg }, 'job failed');
      await this.ctx.db.updateTable('job_runs').set({ finished_at: this.ctx.clock.now(), ok: false, error: msg.slice(0, 1000) }).where('id', '=', run.id).execute();
      await this.ctx.notifications.notify('error', `작업 실패: ${j.label}`, msg.slice(0, 500), { path: '/jobs', dedupeKey: `job-fail-${name}`, dedupeMinutes: 60 });
      return { ok: false, error: msg };
    } finally {
      this.running.delete(name);
    }
  }

  isRunning(name: string): boolean {
    return this.running.has(name);
  }
}
