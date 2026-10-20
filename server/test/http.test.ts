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
    expect((await app.inject({ method: 'POST', url: '/healthz/jobs/watchdog/run', remoteAddress: '127.0.0.1' })).statusCode).toBe(404); // 헤더 없으면 거부
    const run = await app.inject({ method: 'POST', url: '/healthz/jobs/watchdog/run', remoteAddress: '127.0.0.1', headers: { 'x-requested-with': 'app' } });
    expect(run.json()).toEqual({ started: 'watchdog' });
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

    // 작업 지금 실행(= run-job.sh): 백그라운드로 시작하고 바로 응답 → 끝나면 이력
    const job = await app.inject({ method: 'POST', url: '/api/jobs/orders.poll/run', headers: H(cookie) });
    expect(job.json()).toEqual({ started: 'orders.poll', label: '주문 수집·처리' });
    let jobs: any;
    for (let i = 0; i < 50; i++) {
      jobs = (await app.inject({ url: '/api/jobs', headers: { cookie } })).json();
      if (!jobs.jobs.find((j: any) => j.name === 'orders.poll').running) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(jobs.jobs.find((j: any) => j.name === 'orders.poll').last.ok).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/api/jobs/nope/run', headers: H(cookie) })).statusCode).toBe(404);

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

describe('상품 선정 지금 실행 API', () => {
  it('지금 실행은 바로 응답, 실행 중엔 다시 시작·키워드 선정 모두 거부(동시 실행 방지), 기록·감사 로그 남김', async () => {
    const { totpSecret, scheduler } = await setup();
    const cookie = await login(totpSecret);
    // 선정이 오래 걸리는 상황 흉내: 작업을 잡아 둠
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { JOBS } = await import('../src/jobs/scheduler.js');
    const job = JOBS.find((j) => j.name === 'selection.run')!;
    const orig = job.run;
    job.run = async () => { await gate; return { evaluated: 0, passed: 0, autoListed: 0 }; };
    try {
      const r = await app.inject({ method: 'POST', url: '/api/jobs/selection.run/run', headers: H(cookie) });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ started: 'selection.run', label: '상품 선정' });
      expect(scheduler.isRunning('selection.run')).toBe(true);
      const again = await app.inject({ method: 'POST', url: '/api/jobs/selection.run/run', headers: H(cookie) });
      expect(again.statusCode).toBe(409);
      expect(again.json().error ?? again.json().message).toContain('이미 실행 중');
      const kw = await app.inject({ method: 'POST', url: '/api/selection/run', headers: H(cookie), payload: { keywords: ['정리함'] } });
      expect(kw.statusCode).toBe(409);
      release();
      for (let i = 0; i < 50 && scheduler.isRunning('selection.run'); i++) await new Promise((x) => setTimeout(x, 20));
      const jobs = (await app.inject({ url: '/api/jobs', headers: { cookie } })).json();
      expect(jobs.jobs.find((j: any) => j.name === 'selection.run')).toMatchObject({ running: false, last: { ok: true } });
      const auditRow = await h.ctx.db.selectFrom('audit_log').selectAll().where('action', '=', 'job.run').executeTakeFirst();
      expect(auditRow?.target).toBe('selection.run');
    } finally {
      job.run = orig;
      release();
    }
  });
});

describe('강제 판매중지·판매재개 API', () => {
  it('pause = 강제 중지(자동 재개 안 함), resume = 검토 후 재개(결과 메시지)', async () => {
    const { totpSecret } = await setup();
    const cookie = await login(totpSecret);
    const x = await seedActiveListing(h);
    const p = await app.inject({ method: 'POST', url: `/api/listings/${x.listing.id}/pause`, headers: H(cookie) });
    expect(p.statusCode).toBe(200);
    let l = await h.ctx.db.selectFrom('listings').selectAll().where('id', '=', x.listing.id).executeTakeFirstOrThrow();
    expect(l.status_reason).toBe('관리자 중지(강제)');
    const r = await app.inject({ method: 'POST', url: `/api/listings/${x.listing.id}/resume`, headers: H(cookie) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ state: 'resumed' });
    l = await h.ctx.db.selectFrom('listings').selectAll().where('id', '=', x.listing.id).executeTakeFirstOrThrow();
    expect(l.status).toBe('active');
    const again = await app.inject({ method: 'POST', url: `/api/listings/999999/pause`, headers: H(cookie) });
    expect(again.statusCode).toBe(404);
  });
});

describe('상품 목록·상품명 정리 API', () => {
  it('Wing에서 삭제한 상품은 전체·판매종료 목록에서 숨기고 쿠팡 삭제 탭에서 보임, 옵션별 상태, 상품명 정리 제안·일괄 수정함', async () => {
    const { totpSecret } = await setup();
    const cookie = await login(totpSecret);
    const del = await seedActiveListing(h);
    const stopped = await seedActiveListing(h);
    const fix = await seedActiveListing(h);
    await h.ctx.db.updateTable('listings').set({ status: 'stopped', status_reason: '쿠팡에서 삭제됨(Wing에서 삭제)' }).where('id', '=', del.listing.id).execute();
    await h.ctx.db.updateTable('listings').set({ status: 'stopped', status_reason: null }).where('id', '=', stopped.listing.id).execute();
    const all = (await app.inject({ url: '/api/listings', headers: H(cookie) })).json().map((x: any) => x.id);
    expect(all).not.toContain(del.listing.id);
    expect(all).toContain(stopped.listing.id); // 사유 없는 판매종료는 그대로 보임
    const tab = (await app.inject({ url: '/api/listings?status=stopped', headers: H(cookie) })).json().map((x: any) => x.id);
    expect(tab).toContain(stopped.listing.id);
    expect(tab).not.toContain(del.listing.id);
    const deleted = (await app.inject({ url: '/api/listings?status=deleted', headers: H(cookie) })).json();
    expect(deleted.map((x: any) => x.id)).toEqual([del.listing.id]);
    expect(deleted[0].variants).toEqual([]);
    // 여러 옵션 상품: 옵션별 판매가·상태(1개 단위 가격, 멈춘 옵션 사유)
    await h.ctx.db.insertInto('listing_items').values([
      { listing_id: fix.listing.id, unit_qty: 1, item_name: '화이트 1개', source_option: '화이트', sale_price: 10000, floor_price: 9000, created_at: h.clock.now() },
      { listing_id: fix.listing.id, unit_qty: 2, item_name: '화이트 2개', source_option: '화이트', sale_price: 19000, floor_price: 18000, created_at: h.clock.now() },
      { listing_id: fix.listing.id, unit_qty: 1, item_name: '블랙 1개', source_option: '블랙', sale_price: 11000, floor_price: 9000, item_status: 'paused', item_reason: '옵션 품절', created_at: h.clock.now() },
    ]).execute();
    const row = (await app.inject({ url: '/api/listings', headers: H(cookie) })).json().find((x: any) => x.id === fix.listing.id);
    expect(row.variants).toEqual([
      { option: '화이트', price: 10000, status: 'active', reason: null, units: [1, 2] },
      { option: '블랙', price: 11000, status: 'paused', reason: '옵션 품절', units: [1] },
    ]);

    await h.ctx.db.updateTable('listings').set({ dry_run: false, payload: JSON.stringify({ displayProductName: '정리함 블랙', items: [{ attributes: [{ attributeTypeName: '색상', attributeValueName: '블랙' }] }] }) }).where('id', '=', fix.listing.id).execute();
    const fixes = (await app.inject({ url: '/api/listings/name-fixes', headers: H(cookie) })).json();
    expect(fixes).toMatchObject([{ id: fix.listing.id, current: '정리함 블랙', suggested: '정리함' }]);
    const done = await app.inject({ method: 'POST', url: '/api/listings/name-fixes/done', headers: H(cookie), payload: { ids: [fix.listing.id] } });
    expect(done.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/listings/name-fixes', headers: H(cookie) })).json()).toEqual([]);
  });
});

describe('취소·반품·교환 API', () => {
  it('주문 상세에 클레임, [공급처 취소 완료] → 출고중지·취소됨, 잘못된 조치는 409, 판매자 취소', async () => {
    const { totpSecret } = await setup();
    const cookie = await login(totpSecret);
    const { pollClaims, pollNewOrders, processPending } = await import('../src/modules/orders/service.js');
    const { vendorItemId } = await seedActiveListing(h, { source: 'mockmanual' });
    const a = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    const b = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await pollNewOrders(h.ctx);
    await processPending(h.ctx);
    const oa = await orderByBox(h, a.shipmentBoxId);
    await app.inject({ method: 'POST', url: `/api/orders/${oa.id}/purchase`, headers: H(cookie), payload: { sourceOrderId: 'DMK-9', cost: 15000 } });
    h.market.claim({ receiptId: '77', marketOrderId: a.marketOrderId, vendorItemId, type: 'RETURN', stage: 'stop_requested', requestedAt: h.clock.now() });
    await pollClaims(h.ctx);
    const d = (await app.inject({ url: `/api/orders/${oa.id}`, headers: H(cookie) })).json();
    expect(d.status).toBe('CANCEL_REQUESTED');
    expect(d.claims).toHaveLength(1);
    expect(d.claims[0]).toMatchObject({ receipt_id: '77', stage: 'stop_requested', stageLabel: '고객 취소 요청(판매자 처리 필요)' });
    const bad = await app.inject({ method: 'POST', url: `/api/orders/${oa.id}/claims/${d.claims[0].id}`, headers: H(cookie), payload: { action: 'approve_return' } });
    expect(bad.statusCode).toBe(409);
    const ok = await app.inject({ method: 'POST', url: `/api/orders/${oa.id}/claims/${d.claims[0].id}`, headers: H(cookie), payload: { action: 'source_cancelled' } });
    expect(ok.statusCode).toBe(200);
    expect((await orderByBox(h, a.shipmentBoxId)).status).toBe('CANCELLED');
    // 판매자 취소(구매 전 주문)
    const ob = await orderByBox(h, b.shipmentBoxId);
    const c = await app.inject({ method: 'POST', url: `/api/orders/${ob.id}/cancel`, headers: H(cookie), payload: { reason: 'stock' } });
    expect(c.statusCode).toBe(200);
    expect((await orderByBox(h, b.shipmentBoxId)).status).toBe('CANCELLED');
    const audits = await h.ctx.db.selectFrom('audit_log').select('action').execute();
    expect(audits.map((x) => x.action)).toEqual(expect.arrayContaining(['claim.source_cancelled', 'order.seller_cancel']));
  });
});
