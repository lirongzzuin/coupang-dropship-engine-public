import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DryRunMarket } from '../adapters/dryRunMarket.js';
import { FakeMarket } from '../adapters/fake/fakeMarket.js';
import { MockSource } from '../adapters/fake/mockSource.js';
import { type AppContext, audit } from '../context.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { JOBS } from '../jobs/scheduler.js';
import { maskAddress, maskName, maskPhone } from '../lib/logger.js';
import { errMessage } from '../lib/util.js';
import { answerInquiry } from '../modules/cs/service.js';
import { monthlyCsv } from '../modules/finance/service.js';
import { pauseListing, resumeListing } from '../modules/listing/control.js';
import { linkExistingListing, ListingError, quoteSourceItem, registerListing, updateDraft, validateListing } from '../modules/listing/service.js';
import { importCoupangSalesCsv } from '../modules/marketdata/csvImport.js';
import { confirmPurchase, decryptReceiver, OrderError, overrideAndProcess, submitTracking, transition } from '../modules/orders/service.js';
import { ACTION_STATUSES, EXCEPTION_STATUSES, ORDER_STATUSES, type OrderStatus, STATUS_LABEL } from '../modules/orders/stateMachine.js';
import { computeProfit } from '../modules/pricing/pricing.js';
import { dashboard } from '../modules/reports/service.js';
import { decideCandidate, runSelection } from '../modules/selection/service.js';
import { AuthError, AuthService } from './auth.js';

const COOKIE = 'sid';

declare module 'fastify' {
  interface FastifyRequest {
    user?: { username: string };
  }
}

export async function buildServer(ctx: AppContext, scheduler: Scheduler | null, opts: { webDir?: string } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 12 * 1024 * 1024, trustProxy: true });
  const auth = new AuthService(ctx);
  await app.register(fastifyCookie, { secret: ctx.env.SESSION_SECRET });
  app.addContentTypeParser(['image/jpeg', 'image/png', 'image/webp', 'text/csv', 'text/plain'], { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  // 본문 없는 JSON POST(버튼형 액션)도 허용
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = String(body ?? '').trim();
    if (!text) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(Object.assign(new Error('JSON 형식 오류'), { statusCode: 400 }), undefined);
    }
  });

  // ── 공통 에러 처리 ──
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AuthError) return reply.code(401).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ') });
    if (err instanceof OrderError || err instanceof ListingError) return reply.code(409).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: errMessage(err) });
    ctx.log.error({ err: errMessage(err) }, 'http error');
    return reply.code(500).send({ error: errMessage(err) });
  });

  // ── 공개 엔드포인트 ──
  app.get('/healthz', async () => {
    const last = await ctx.kv.get<string>('orders.lastPollOkAt');
    return { ok: true, lastOrderPollAt: last ?? null, dryRun: ctx.env.DRY_RUN };
  });

  app.get('/media/:key', async (req, reply) => {
    const { key } = req.params as { key: string };
    const f = await ctx.storage.get(key);
    if (!f) return reply.code(404).send();
    return reply.header('Content-Type', f.contentType).header('Cache-Control', 'public, max-age=31536000, immutable').send(f.data);
  });

  app.get('/api/auth/status', async (req) => ({
    setupRequired: !(await auth.hasAdmin()),
    user: (await auth.session(req.cookies[COOKIE] ? req.unsignCookie(req.cookies[COOKIE]!).value ?? undefined : undefined)) ?? null,
  }));

  app.post('/api/auth/login', async (req, reply) => {
    const b = z.object({ username: z.string(), password: z.string(), totp: z.string() }).parse(req.body);
    const sid = await auth.login(b.username, b.password, b.totp, req.ip);
    reply.setCookie(COOKIE, sid, { path: '/', httpOnly: true, sameSite: 'strict', secure: ctx.env.PUBLIC_BASE_URL.startsWith('https'), signed: true, maxAge: 14 * 86400 });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const raw = req.cookies[COOKIE];
    await auth.logout(raw ? req.unsignCookie(raw).value ?? undefined : undefined);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  // ── 인증 필요 ──
  const guard = async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = req.cookies[COOKIE];
    const sid = raw ? req.unsignCookie(raw).value ?? undefined : undefined;
    const user = await auth.session(sid);
    if (!user) return reply.code(401).send({ error: '로그인이 필요합니다' });
    req.user = user;
  };

  await app.register(async (api) => {
    api.addHook('preHandler', guard);
    // 상태 변경 요청은 동일 출처만(CSRF 방어: SameSite=Strict + 커스텀 헤더)
    api.addHook('preHandler', async (req, reply) => {
      if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'app') return reply.code(403).send({ error: 'CSRF 차단' });
    });
    const actor = (req: FastifyRequest) => req.user?.username ?? 'admin';
    const idParam = (req: FastifyRequest) => z.coerce.number().int().parse((req.params as { id: string }).id);

    api.get('/api/dashboard', async () => dashboard(ctx));
    api.get('/api/meta', async () => ({
      statuses: ORDER_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] })),
      actionStatuses: ACTION_STATUSES,
      exceptionStatuses: EXCEPTION_STATUSES,
      sources: ctx.sources.list().map((s) => ({ id: s.id, name: s.displayName, capabilities: s.capabilities })),
      jobs: JOBS.map((j) => ({ name: j.name, label: j.label })),
      demo: ctx.env.DEMO_MODE,
    }));

    // ── 주문 ──
    api.get('/api/orders', async (req) => {
      const q = z.object({ status: z.string().optional(), view: z.enum(['action', 'exception', 'active', 'all']).optional(), limit: z.coerce.number().default(100) }).parse(req.query);
      let query = ctx.db.selectFrom('orders').leftJoin('source_products', 'source_products.id', 'orders.source_product_id')
        .select(['orders.id', 'orders.market_order_id', 'orders.item_name', 'orders.qty', 'orders.sale_amount', 'orders.status', 'orders.status_reason', 'orders.ordered_at', 'orders.ship_by', 'orders.expected_profit', 'orders.profit', 'orders.tracking_no', 'orders.purchase_strategy', 'source_products.source as source', 'orders.receiver_name_enc'])
        .orderBy('orders.id', 'desc').limit(Math.min(500, q.limit));
      if (q.status) query = query.where('orders.status', '=', q.status);
      if (q.view === 'action') query = query.where('orders.status', 'in', ACTION_STATUSES);
      if (q.view === 'exception') query = query.where('orders.status', 'in', EXCEPTION_STATUSES);
      if (q.view === 'active') query = query.where('orders.status', 'not in', ['SETTLED', 'CANCELLED', 'RETURNED']);
      const rows = await query.execute();
      return rows.map(({ receiver_name_enc, ...r }) => ({ ...r, statusLabel: STATUS_LABEL[r.status as OrderStatus], receiver: maskName(ctx.pii.decrypt(receiver_name_enc)) }));
    });

    api.get('/api/orders/:id', async (req) => {
      const id = idParam(req);
      const o = await ctx.db.selectFrom('orders').selectAll().where('id', '=', id).executeTakeFirst();
      if (!o) throw Object.assign(new Error('주문 없음'), { statusCode: 404 });
      const sp = o.source_product_id ? await ctx.db.selectFrom('source_products').selectAll().where('id', '=', o.source_product_id).executeTakeFirst() : undefined;
      const listing = o.listing_id ? await ctx.db.selectFrom('listings').select(['id', 'title', 'sale_price']).where('id', '=', o.listing_id).executeTakeFirst() : undefined;
      const events = await ctx.db.selectFrom('order_events').selectAll().where('order_id', '=', id).orderBy('id').execute();
      const r = o.pii_purged_at ? null : decryptReceiver(ctx, o);
      const s = await ctx.settings.get();
      const profitIfCost = sp ? computeProfit(s, o.sale_amount, { cost: (o.purchase_cost ?? sp.price * o.qty), shipping: o.purchase_shipping ?? sp.shipping_fee, categoryPath: sp.category_path, inputVatDeductible: sp.tax_invoice }) : null;
      const { receiver_name_enc, receiver_phone_enc, receiver_addr_enc, delivery_message_enc, ...safe } = o;
      return {
        ...safe,
        statusLabel: STATUS_LABEL[o.status as OrderStatus],
        receiverMasked: r ? { name: maskName(r.name), phone: maskPhone(r.phone), addr: maskAddress(r.addr1) } : null,
        source: sp ? { id: sp.id, source: sp.source, sourceName: ctx.sources.get(sp.source)?.displayName ?? sp.source, title: sp.title, url: sp.url, price: sp.price, shippingFee: sp.shipping_fee, apiOrder: !!ctx.sources.get(sp.source)?.capabilities.apiOrder } : null,
        listing: listing ?? null,
        events,
        profitEstimate: profitIfCost,
        courierAliases: Object.keys(s.orders.courierAliases),
      };
    });

    /** 구매 작업용 수취인 원문(열람 기록 남김) */
    api.get('/api/orders/:id/receiver', async (req) => {
      const id = idParam(req);
      const o = await ctx.db.selectFrom('orders').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      if (o.pii_purged_at) throw Object.assign(new Error('개인정보 보관기간이 지나 파기되었습니다'), { statusCode: 410 });
      await audit(ctx, actor(req), 'pii.view', String(id));
      return decryptReceiver(ctx, o);
    });

    api.post('/api/orders/:id/purchase', async (req) => {
      const b = z.object({ sourceOrderId: z.string().optional(), cost: z.coerce.number().int().nonnegative().optional(), shippingCost: z.coerce.number().int().nonnegative().optional() }).parse(req.body ?? {});
      return confirmPurchase(ctx, idParam(req), b, actor(req));
    });
    api.post('/api/orders/:id/tracking', async (req) => {
      const b = z.object({ courier: z.string().min(1), trackingNo: z.string().min(4) }).parse(req.body);
      return submitTracking(ctx, idParam(req), b.courier, b.trackingNo, actor(req));
    });
    api.post('/api/orders/:id/override', async (req) => overrideAndProcess(ctx, idParam(req), actor(req)));
    api.post('/api/orders/:id/status', async (req) => {
      const b = z.object({ status: z.enum(ORDER_STATUSES), reason: z.string().default('관리자 변경') }).parse(req.body);
      const o = await ctx.db.selectFrom('orders').selectAll().where('id', '=', idParam(req)).executeTakeFirstOrThrow();
      await audit(ctx, actor(req), 'order.status', String(o.id), b);
      return transition(ctx, o, b.status, b.reason, actor(req));
    });

    // ── 후보 ──
    api.get('/api/candidates', async (req) => {
      const q = z.object({ status: z.string().default('new'), passed: z.enum(['true', 'false', 'all']).default('true') }).parse(req.query);
      let query = ctx.db.selectFrom('candidates').innerJoin('source_products', 'source_products.id', 'candidates.source_product_id')
        .select(['candidates.id', 'candidates.keyword', 'candidates.score', 'candidates.passed', 'candidates.target_price', 'candidates.est_profit', 'candidates.est_margin', 'candidates.market_lowest', 'candidates.status', 'candidates.gates', 'candidates.created_at',
          'source_products.title', 'source_products.source', 'source_products.price', 'source_products.shipping_fee', 'source_products.url', 'source_products.image_url', 'source_products.image_reuse_allowed'])
        .orderBy('candidates.score', 'desc').limit(200);
      if (q.status !== 'all') query = query.where('candidates.status', '=', q.status);
      if (q.passed !== 'all') query = query.where('candidates.passed', '=', q.passed === 'true');
      return query.execute();
    });
    api.post('/api/candidates/:id/approve', async (req) => decideCandidate(ctx, idParam(req), true, actor(req)));
    api.post('/api/candidates/:id/reject', async (req) => decideCandidate(ctx, idParam(req), false, actor(req)));
    api.post('/api/selection/run', async (req) => {
      const b = z.object({ keywords: z.array(z.string()).optional() }).parse(req.body ?? {});
      return runSelection(ctx, { keywords: b.keywords?.length ? b.keywords : undefined });
    });

    // ── 등록 상품 ──
    api.get('/api/listings', async (req) => {
      const q = z.object({ status: z.string().optional() }).parse(req.query);
      let query = ctx.db.selectFrom('listings').innerJoin('source_products', 'source_products.id', 'listings.source_product_id')
        .select(['listings.id', 'listings.title', 'listings.status', 'listings.status_reason', 'listings.sale_price', 'listings.floor_price', 'listings.images', 'listings.vendor_item_id', 'listings.seller_product_id', 'listings.category_code', 'listings.category_name', 'listings.search_tags', 'listings.dry_run', 'listings.listed_at', 'listings.updated_at',
          'source_products.source', 'source_products.price as source_price', 'source_products.shipping_fee as source_shipping', 'source_products.stock as source_stock', 'source_products.url as source_url', 'source_products.image_reuse_allowed'])
        .orderBy('listings.id', 'desc').limit(300);
      if (q.status) query = query.where('listings.status', '=', q.status);
      return query.execute();
    });
    api.patch('/api/listings/:id', async (req) => {
      const b = z.object({ title: z.string().optional(), salePrice: z.coerce.number().int().positive().optional(), images: z.array(z.string().url()).optional(), categoryCode: z.string().optional(), tags: z.array(z.string()).optional() }).parse(req.body);
      return updateDraft(ctx, idParam(req), b, actor(req));
    });
    api.get('/api/listings/:id/validate', async (req) => {
      const l = await ctx.db.selectFrom('listings').selectAll().where('id', '=', idParam(req)).executeTakeFirstOrThrow();
      return { problems: await validateListing(ctx, l) };
    });
    // 쿠팡에 직접 등록할 상품의 견적(상품명·판매가·이미지) / 이미 등록된 쿠팡 상품 연결
    api.post('/api/tools/quote', async (req) => {
      const b = z.object({ source: z.string().min(1), sourceItemId: z.string().min(1) }).parse(req.body);
      return quoteSourceItem(ctx, b.source, b.sourceItemId);
    });
    api.post('/api/listings/link', async (req) => {
      const b = z.object({
        vendorItemId: z.string().min(1), sellerProductId: z.string().optional(), salePrice: z.coerce.number().int().positive(),
        source: z.string().min(1), sourceItemId: z.string().min(1), title: z.string().optional(),
      }).parse(req.body);
      return linkExistingListing(ctx, b, actor(req));
    });
    api.post('/api/listings/:id/register', async (req) => registerListing(ctx, idParam(req), actor(req)));
    api.post('/api/listings/:id/pause', async (req) => {
      const l = await ctx.db.selectFrom('listings').selectAll().where('id', '=', idParam(req)).executeTakeFirstOrThrow();
      return { ok: await pauseListing(ctx, l, '관리자 중지') };
    });
    api.post('/api/listings/:id/resume', async (req) => {
      const l = await ctx.db.selectFrom('listings').selectAll().where('id', '=', idParam(req)).executeTakeFirstOrThrow();
      return { ok: await resumeListing(ctx, { ...l, status: 'paused' }) };
    });

    // ── 이미지 업로드(쿠팡이 내려받을 공개 URL 생성) ──
    api.post('/api/media', async (req) => {
      const type = String(req.headers['content-type'] ?? '').split(';')[0]!;
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) throw Object.assign(new Error('JPG/PNG/WEBP만 가능'), { statusCode: 415 });
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) throw Object.assign(new Error('파일이 비었습니다'), { statusCode: 400 });
      if (body.length > 3 * 1024 * 1024 && type !== 'image/webp') throw Object.assign(new Error('쿠팡 이미지 제한: 3MB 이하'), { statusCode: 413 });
      const key = `${randomUUID()}.${type.split('/')[1] === 'jpeg' ? 'jpg' : type.split('/')[1]}`;
      const url = await ctx.storage.put(key, body, type);
      await ctx.db.insertInto('media').values({ id: key, filename: key, content_type: type, size: body.length, created_at: ctx.clock.now() }).execute();
      return { url };
    });

    // ── 고객문의 ──
    api.get('/api/inquiries', async () => ctx.db.selectFrom('inquiries').selectAll().orderBy('id', 'desc').limit(200).execute());
    api.post('/api/inquiries/:id/answer', async (req) => {
      const b = z.object({ text: z.string().min(1) }).parse(req.body);
      await answerInquiry(ctx, idParam(req), b.text, actor(req));
      return { ok: true };
    });

    // ── 설정 ──
    api.get('/api/settings', async () => ctx.settings.get());
    api.put('/api/settings', async (req) => {
      const next = await ctx.settings.update(req.body);
      await audit(ctx, actor(req), 'settings.update', undefined, req.body);
      return next;
    });
    api.post('/api/kill-switch', async (req) => {
      const b = z.object({ on: z.boolean() }).parse(req.body);
      await ctx.settings.update({ killSwitch: b.on });
      await audit(ctx, actor(req), 'killswitch', undefined, b);
      await ctx.notifications.notify(b.on ? 'error' : 'info', b.on ? '긴급 정지 켜짐' : '긴급 정지 해제', b.on ? '등록·가격·발주·송장·답변이 모두 중단됩니다(주문 감지는 계속).' : '자동 운영을 재개합니다.');
      return { killSwitch: b.on };
    });

    // ── 시장 데이터·재무·작업 ──
    api.post('/api/market-data/coupang-sales', async (req) => {
      const tool = String((req.query as { tool?: string }).tool ?? 'unknown');
      const text = Buffer.isBuffer(req.body) ? (req.body as Buffer).toString('utf8') : String((req.body as { csv?: string })?.csv ?? '');
      return importCoupangSalesCsv(ctx, text, tool);
    });
    api.get('/api/finance/monthly.csv', async (req, reply) => {
      const q = z.object({ month: z.string() }).parse(req.query);
      const csv = await monthlyCsv(ctx, q.month);
      return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="profit-${q.month}.csv"`).send(csv);
    });
    api.get('/api/jobs', async () => {
      const runs = await ctx.db.selectFrom('job_runs').selectAll().orderBy('id', 'desc').limit(100).execute();
      return { jobs: JOBS.map((j) => ({ name: j.name, label: j.label, running: scheduler?.isRunning(j.name) ?? false, last: runs.find((r) => r.job === j.name) ?? null })), runs };
    });
    api.post('/api/jobs/:name/run', async (req) => {
      if (!scheduler) throw Object.assign(new Error('스케줄러 비활성'), { statusCode: 503 });
      const { name } = req.params as { name: string };
      return scheduler.runJob(name);
    });
    // ── 체험 모드: 가짜 쿠팡에 주문 생성·배송 진행 ──
    const fake = ctx.env.DEMO_MODE ? (ctx.market instanceof DryRunMarket ? ctx.market.innerFake() : ctx.market instanceof FakeMarket ? ctx.market : undefined) : undefined;
    if (fake) {
      api.post('/api/demo/order', async (req) => {
        const b = z.object({ listingId: z.coerce.number().int().optional() }).parse(req.body ?? {});
        let q = ctx.db.selectFrom('listings').selectAll().where('status', '=', 'active').where('vendor_item_id', 'is not', null);
        if (b.listingId) q = q.where('id', '=', b.listingId);
        const l = await q.orderBy('id', 'desc').executeTakeFirst();
        if (!l) throw Object.assign(new Error('판매중인 상품이 없습니다(후보 승인·등록 → 상품 승인 작업 실행)'), { statusCode: 409 });
        const line = fake.seedOrder({ vendorItemId: l.vendor_item_id!, paidAmount: l.sale_price, itemName: l.title, orderedAt: ctx.clock.now() });
        return { shipmentBoxId: line.shipmentBoxId, listingId: l.id };
      });
      api.post('/api/demo/advance', async () => {
        // 공급처 출고(송장 발급) → 배송중 → 배송완료 순으로 한 단계씩 진행
        let shipped = 0, moved = 0;
        for (const src of ctx.sources.list()) {
          if (!(src instanceof MockSource)) continue;
          for (const [id, o] of src.orders) if (!o.tracking) { src.ship(id, `6${String(Date.now()).slice(-11)}`); shipped++; }
        }
        const orders = await ctx.db.selectFrom('orders').select(['shipment_box_id', 'status']).where('status', 'in', ['TRACKING_UPLOADED', 'IN_TRANSIT']).execute();
        for (const o of orders) {
          for (const l of fake.orders.get(o.shipment_box_id) ?? []) {
            l.status = o.status === 'TRACKING_UPLOADED' ? 'DELIVERING' : 'FINAL_DELIVERY';
            moved++;
          }
        }
        return { shipped, moved };
      });
    }
    api.get('/api/notifications', async () => ctx.db.selectFrom('notifications').selectAll().orderBy('id', 'desc').limit(100).execute());
    api.get('/api/audit', async () => ctx.db.selectFrom('audit_log').selectAll().orderBy('id', 'desc').limit(200).execute());
  });

  // ── 관리자 웹(SPA) 정적 서빙 ──
  // 상대경로로 줘도 동작하도록 항상 절대경로로 변환
  const webDir = resolve(opts.webDir ?? '../web/dist');
  if (existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir, prefix: '/', wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/media/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
