import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/http/server.js';
import { AuthService } from '../src/http/auth.js';
import { Scheduler } from '../src/jobs/scheduler.js';
import { totpAt } from '../src/lib/crypto.js';
import { makeHarness, orderByBox, seedActiveListing, type TestHarness } from './helpers.js';

let h: TestHarness;
let app: Awaited<ReturnType<typeof buildServer>>;
afterEach(async () => {
  await app?.close();
  await h?.close();
});

async function setup() {
  h = await makeHarness({ live: true });
  const scheduler = new Scheduler(h.ctx);
  app = await buildServer(h.ctx, scheduler, { webDir: '/nonexistent' });
  const { totpSecret } = await new AuthService(h.ctx).createAdmin('admin', 'very-strong-pass');
  return { totpSecret, scheduler };
}

async function login(totpSecret: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'very-strong-pass', totp: totpAt(totpSecret, h.clock.now().getTime()) } });
  expect(res.statusCode).toBe(200);
  const c = res.cookies.find((x) => x.name === 'sid')!;
  expect(c.httpOnly).toBe(true);
  return `sid=${c.value}`;
}

const H = (cookie: string) => ({ cookie, 'x-requested-with': 'app' });

describe('HTTP API', () => {
  it('인증: 미로그인 401, 잘못된 OTP 거부, 5회 실패 잠금, 로그인·로그아웃', async () => {
    const { totpSecret } = await setup();
    expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
    // 작업 현황: Mac 안(로컬)만, Tailscale 프록시 경유(헤더 있음)는 숨김
    const jobs = await app.inject({ url: '/healthz/jobs', remoteAddress: '127.0.0.1' });
    expect(jobs.statusCode).toBe(200);
    expect(jobs.json().map((j: any) => j.job)).toContain('orders.poll');
    expect((await app.inject({ url: '/healthz/jobs', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '100.64.0.2' } })).statusCode).toBe(404);
    expect((await app.inject({ url: '/healthz/jobs', remoteAddress: '100.64.0.2' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/dashboard' })).statusCode).toBe(401);
    const st = await app.inject({ url: '/api/auth/status' });
    expect(st.json()).toMatchObject({ setupRequired: false, user: null });
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'very-strong-pass', totp: '000000' } });
    expect(bad.statusCode).toBe(401);
    const cookie = await login(totpSecret);
    expect((await app.inject({ url: '/api/dashboard', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/auth/status', headers: { cookie } })).json().user).toEqual({ username: 'admin' });
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect((await app.inject({ url: '/api/dashboard', headers: { cookie } })).statusCode).toBe(401);
    for (let i = 0; i < 5; i++) await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'x', password: 'y', totp: '1' } });
    const locked = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'x', password: 'y', totp: '1' } });
    expect(locked.json().error).toMatch(/시도 제한/);
  });

  it('CSRF: 커스텀 헤더 없는 POST 차단', async () => {
    const { totpSecret } = await setup();
    const cookie = await login(totpSecret);
    const r = await app.inject({ method: 'POST', url: '/api/kill-switch', headers: { cookie }, payload: { on: true } });
    expect(r.statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: '/api/kill-switch', headers: H(cookie), payload: { on: true } });
    expect(ok.json()).toEqual({ killSwitch: true });
    expect((await h.ctx.settings.get()).killSwitch).toBe(true);
  });

  it('주문 작업함: 목록(마스킹) → 상세 → 수취인 열람(감사로그) → 구매확인 → 송장', async () => {
    const { totpSecret } = await setup();
    const cookie = await login(totpSecret);
    const { vendorItemId } = await seedActiveListing(h, { source: 'mockmanual' });
    const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now(), receiver: { name: '박고객', phone: '010-5555-6666', addr1: '대구 중구 B로 2', addr2: '3층', zip: '41900' } });
    await h.ctx.settings.update({});
    const { pollNewOrders, processPending } = await import('../src/modules/orders/service.js');
    await pollNewOrders(h.ctx);
    await processPending(h.ctx);
    const o = await orderByBox(h, line.shipmentBoxId);

    const list = (await app.inject({ url: '/api/orders?view=action', headers: { cookie } })).json();
    expect(list).toHaveLength(1);
    expect(list[0].receiver).toBe('박*객');
    expect(JSON.stringify(list)).not.toContain('010-5555');

    const detail = (await app.inject({ url: `/api/orders/${o.id}`, headers: { cookie } })).json();
    expect(detail.statusLabel).toBe('구매 필요');
    expect(detail.receiverMasked.phone).toBe('010-****-6666');
    expect(detail.source.url).toContain('mock.example');
    expect(detail.receiver_name_enc).toBeUndefined();

    const rcv = (await app.inject({ url: `/api/orders/${o.id}/receiver`, headers: { cookie } })).json();
    expect(rcv).toMatchObject({ name: '박고객', phone: '010-5555-6666', addr1: '대구 중구 B로 2', addr2: '3층', zip: '41900' });
    const auditRows = await h.ctx.db.selectFrom('audit_log').selectAll().where('action', '=', 'pii.view').execute();
    expect(auditRows).toHaveLength(1);

    const p = await app.inject({ method: 'POST', url: `/api/orders/${o.id}/purchase`, headers: H(cookie), payload: { sourceOrderId: '2026101300001', cost: 15000 } });
    expect(p.statusCode).toBe(200);
    expect(p.json().status).toBe('PURCHASED');
    const bad = await app.inject({ method: 'POST', url: `/api/orders/${o.id}/purchase`, headers: H(cookie), payload: { sourceOrderId: 'x' } });
    expect(bad.statusCode).toBe(409);
    const t = await app.inject({ method: 'POST', url: `/api/orders/${o.id}/tracking`, headers: H(cookie), payload: { courier: '한진택배', trackingNo: '5123 4567 8901' } });
    expect(t.json().status).toBe('TRACKING_UPLOADED');
    expect(h.market.invoices[0]!.courierCode).toBe('HANJIN');
  });

  it('후보·등록상품·이미지 업로드·설정·CSV·작업 실행', async () => {
    const { totpSecret } = await setup();
    const cookie = await login(totpSecret);
    await h.ctx.settings.update({ selection: { mode: 'manual_approve' } });
    h.apiSource.add({ sourceItemId: 'H1', title: '라탄 수납 정리함', price: 15000 });
    h.marketData.lowest.set('정리함', 40000);
    const run = await app.inject({ method: 'POST', url: '/api/selection/run', headers: H(cookie), payload: { keywords: ['정리함'] } });
    expect(run.json()).toMatchObject({ evaluated: 1, passed: 1 });
    const cands = (await app.inject({ url: '/api/candidates', headers: { cookie } })).json();
    expect(cands).toHaveLength(1);
    const ap = (await app.inject({ method: 'POST', url: `/api/candidates/${cands[0].id}/approve`, headers: H(cookie) })).json();
    expect(ap.listingId).toBeGreaterThan(0);

    // 하한가 미만 수정 거부
    const low = await app.inject({ method: 'PATCH', url: `/api/listings/${ap.listingId}`, headers: H(cookie), payload: { salePrice: 1000 } });
    expect(low.statusCode).toBe(409);

    // 이미지 업로드 → 공개 URL 서빙
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const up = await app.inject({ method: 'POST', url: '/api/media', headers: { ...H(cookie), 'content-type': 'image/png' }, payload: png });
    expect(up.statusCode).toBe(200);
    const url: string = up.json().url;
    expect(url).toMatch(/^http:\/\/localhost:8080\/media\/.+\.png$/);
    const media = await app.inject({ url: new URL(url).pathname });
    expect(media.statusCode).toBe(200);
    expect(media.headers['content-type']).toBe('image/png');
    expect(media.rawPayload.equals(png)).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/api/media', headers: { ...H(cookie), 'content-type': 'text/plain' }, payload: 'x' })).statusCode).toBe(415);

    // 설정 수정 검증
    const put = await app.inject({ method: 'PUT', url: '/api/settings', headers: H(cookie), payload: { pricing: { minProfitKrw: 3000 } } });
    expect(put.json().pricing.minProfitKrw).toBe(3000);
    const badPut = await app.inject({ method: 'PUT', url: '/api/settings', headers: H(cookie), payload: { pricing: { minProfitKrw: 'abc' } } });
    expect(badPut.statusCode).toBe(400);

    // 쿠팡 판매량 CSV
    const csv = await app.inject({ method: 'POST', url: '/api/market-data/coupang-sales?tool=test', headers: { ...H(cookie), 'content-type': 'text/csv' }, payload: '키워드,판매량\n정리함,300\n' });
    expect(csv.json()).toEqual({ imported: 1, skipped: 0 });

    // 월 손익 CSV
    const m = await app.inject({ url: '/api/finance/monthly.csv?month=2026-10', headers: { cookie } });
    expect(m.headers['content-type']).toContain('text/csv');
    expect(m.body).toContain('합계');

    // 작업 수동 실행 → 이력
    const job = await app.inject({ method: 'POST', url: '/api/jobs/orders.poll/run', headers: H(cookie) });
    expect(job.json().ok).toBe(true);
    const jobs = (await app.inject({ url: '/api/jobs', headers: { cookie } })).json();
    expect(jobs.jobs.find((j: any) => j.name === 'orders.poll').last.ok).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/api/jobs/nope/run', headers: H(cookie) })).json().ok).toBe(false);

    const meta = (await app.inject({ url: '/api/meta', headers: { cookie } })).json();
    expect(meta.sources.map((s: any) => s.id)).toEqual(['mockapi', 'mockmanual']);
    const dash = (await app.inject({ url: '/api/dashboard', headers: { cookie } })).json();
    expect(dash).toHaveProperty('actionCount');
  });
});

describe('Scheduler', () => {
  it('주기 도래 작업 실행·중복 실행 방지·실패 기록 및 알림·일일 리포트 하루 1회', async () => {
    h = await makeHarness({ live: true });
    let runs = 0;
    let fail = true;
    const s = new Scheduler(h.ctx, [
      { name: 'a', label: 'A', intervalMs: () => 60_000, run: async () => { runs++; return { runs }; } },
      { name: 'b', label: 'B', intervalMs: () => 60_000, run: async () => { if (fail) throw new Error('boom'); return 1; } },
      { name: 'daily', label: 'D', intervalMs: () => null, due: (ctx, st, last) => !last || last.toISOString().slice(0, 10) !== ctx.clock.now().toISOString().slice(0, 10), run: async () => 'r' },
    ]);
    await s.init();
    await s.tick();
    await new Promise((r) => setTimeout(r, 200));
    expect(runs).toBe(1);
    await s.tick(); // 주기 미도래
    await new Promise((r) => setTimeout(r, 100));
    expect(runs).toBe(1);
    h.clock.advanceMinutes(2);
    await s.tick();
    await new Promise((r) => setTimeout(r, 200));
    expect(runs).toBe(2);
    const failed = await h.ctx.db.selectFrom('job_runs').selectAll().where('job', '=', 'b').execute();
    expect(failed[0]!.ok).toBe(false);
    expect(failed[0]!.error).toBe('boom');
    expect(h.notifier.titles()).toContain('작업 실패: B');
    fail = false;
    expect((await s.runJob('b')).ok).toBe(true);
    const daily = await h.ctx.db.selectFrom('job_runs').selectAll().where('job', '=', 'daily').execute();
    expect(daily).toHaveLength(1);
  });
});
