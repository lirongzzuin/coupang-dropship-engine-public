import { isLive } from '../../config/env.js';
import { type AppContext, audit, marketFor } from '../../context.js';
import type { ListingRow } from '../../db/schema.js';
import { errMessage } from '../../lib/util.js';
import { detailOf } from '../catalog.js';
import { getHalt } from '../guard/safety.js';
import { getItems, listingVariants, planItems, saveItems } from '../listing/items.js';
import { matchCategory, naverCategories } from './category.js';
import { buildNaverPayload, withinOptionPriceRule } from './payload.js';

/**
 * 스마트스토어 자동 등록: 쿠팡에서 판매 중인 상품을 스마트스토어에도 올린다(같은 공급처 상품·이미지·상세).
 * - 가격: 스마트스토어 수수료(naver.feeRate)로 하한가·판매가를 다시 계산(쿠팡보다 수수료가 낮아 더 싸게 팔 수 있음)
 * - 옵션: 쿠팡에서 판매 중인 옵션(공급처 옵션×묶음 수량)만, 옵션가 정책(±50%)에 맞는 것만
 * - 카테고리: 공급처 카테고리 경로 → 스마트스토어 카테고리 매칭(못 맞추면 등록 안 함)
 * - 이미지: 쿠팡 등록에 쓴 이미지(우리 서버 .jpg)를 스마트스토어 이미지 서버에 올려서 사용(실등록일 때)
 * 실패한 상품은 7일 동안 다시 시도하지 않는다(같은 오류 반복 방지).
 */
export class NaverSkip extends Error {}

const RETRY_DAYS = 7;
/** 한 번 실행에서 등록 API 오류가 이만큼 나면 중단(같은 원인으로 전부 실패하는 것 방지) */
const MAX_ERRORS = 3;
/** 인증정보(KC·어린이제품 인증, 모델명)가 꼭 있어야 하는 카테고리 → 자동 등록 대상 아님 */
const CERT_REQUIRED = /productCertificationInfos|KC ?인증대상|어린이(제품|인증)/;
/** 등록 오류 수정 뒤 한 번: 그 전 실패분을 7일 기다리지 않고 바로 다시 시도 */
const RESET_KEY = 'naver.mirrorReset';
const RESET_VERSION = 1;

export interface MirrorResult {
  created: number;
  skipped: string[];
  errors: string[];
}

export async function naverMirror(ctx: AppContext): Promise<MirrorResult> {
  const s = await ctx.settings.get();
  const out: MirrorResult = { created: 0, skipped: [], errors: [] };
  const naver = ctx.markets?.naver;
  if (!s.naver.enabled || !naver || s.killSwitch || (await getHalt(ctx))) return out;
  const now = ctx.clock.now();
  const live = isLive(ctx.env, 'LIVE_LISTING');
  await resetOldFailures(ctx);
  const naverRows = await ctx.db.selectFrom('listings').select(['source_product_id', 'status', 'dry_run', 'updated_at']).where('market', '=', 'naver').execute();
  const activeCount = naverRows.filter((r) => ['active', 'pending_approval', 'paused'].includes(r.status) && (!live || !r.dry_run)).length;
  let room = Math.min(s.naver.perRun, s.naver.maxListings - activeCount);
  if (room <= 0) return out;
  // 이미 스마트스토어에 있는 상품(모의 등록분·오래된 실패는 다시 시도)
  const blocked = new Set(naverRows.filter((r) => {
    if (r.status === 'stopped' && r.dry_run && live) return false;
    if (r.status === 'rejected' && now.getTime() - new Date(r.updated_at).getTime() > RETRY_DAYS * 86400_000) return false;
    return true;
  }).map((r) => r.source_product_id));
  let q = ctx.db.selectFrom('listings').selectAll().where('market', '=', ctx.market.name).where('status', '=', 'active').orderBy('listed_at');
  if (live) q = q.where('dry_run', '=', false);
  const skipMemo = (await ctx.kv.get<Record<string, string>>('naver.skip')) ?? {};
  for (const l of await q.execute()) {
    if (room <= 0 || out.errors.length >= MAX_ERRORS) break;
    if (blocked.has(l.source_product_id)) continue;
    const memo = skipMemo[String(l.source_product_id)];
    if (memo && now.getTime() - new Date(memo).getTime() < RETRY_DAYS * 86400_000) continue;
    try {
      await createNaverListing(ctx, l);
      out.created++;
      room--;
    } catch (e) {
      skipMemo[String(l.source_product_id)] = now.toISOString();
      const msg = errMessage(e);
      if (e instanceof NaverSkip) out.skipped.push(`${l.title.slice(0, 28)}: ${msg}`);
      else if (CERT_REQUIRED.test(msg)) out.skipped.push(`${l.title.slice(0, 28)}: KC·어린이제품 인증 필요 카테고리(직접 등록)`);
      else out.errors.push(`${l.title.slice(0, 28)}: ${msg}`);
    }
  }
  await ctx.kv.set('naver.skip', skipMemo);
  if (out.created || out.errors.length) {
    await ctx.notifications.notify(out.errors.length ? 'warn' : 'info', `스마트스토어 등록 요청 ${out.created}개${out.errors.length ? ` · 실패 ${out.errors.length}개` : ''}`,
      [...out.errors.map((x) => `✗ ${x}`), ...out.skipped.slice(0, 5).map((x) => `· 건너뜀 ${x}`)].join('\n') || '스마트스토어 상태 확인 후 판매가 시작됩니다.', { path: '/listings' });
  }
  return out;
}

/** 쿠팡 상품 1개 → 스마트스토어 등록 요청(심사중). 실패하면 반려 상태로 남김(7일 뒤 재시도) */
export async function createNaverListing(ctx: AppContext, l: ListingRow): Promise<ListingRow> {
  const s = await ctx.settings.get();
  const sp = await ctx.db.selectFrom('source_products').selectAll().where('id', '=', l.source_product_id).executeTakeFirstOrThrow();
  const d = detailOf(sp);
  if (s.naver.skipKcProducts && d?.kc?.certified) throw new NaverSkip('KC 인증 상품(인증정보 직접 입력 필요)');
  const cp = (typeof l.payload === 'string' ? JSON.parse(l.payload) : l.payload) as { items?: Array<{ images?: Array<{ vendorPath: string }>; contents?: Array<{ contentDetails?: Array<{ content: string }> }> }> } | null;
  const first = cp?.items?.[0];
  const srcImages = (first?.images ?? []).map((x) => x.vendorPath).filter(Boolean);
  const detailHtml = first?.contents?.[0]?.contentDetails?.[0]?.content ?? '';
  if (!srcImages.length || !detailHtml) throw new NaverSkip('쿠팡 등록 정보(이미지·상세) 없음 — 직접 연결한 상품');
  const cats = await naverCategories(ctx);
  if (!cats.length) throw new Error('스마트스토어 카테고리 목록을 가져오지 못함');
  const cat = matchCategory(cats, sp.category_path, l.title, s.naver.categoryMap, s.naver.minCategoryScore);
  if (!cat) throw new NaverSkip(`카테고리 매칭 실패(${sp.category_path ?? '경로 없음'}) — 설정 naver.categoryMap 으로 직접 지정 가능`);

  // 쿠팡에서 판매 중인 옵션(공급처 옵션 × 수량)만 스마트스토어 수수료로 다시 계산
  const selling = new Set((await getItems(ctx, l)).filter((i) => i.item_status !== 'paused').map((i) => `${i.source_option}|${i.unit_qty}`));
  const variants = await listingVariants(ctx, l);
  const plans = withinOptionPriceRule((await planItems(ctx, sp, l.title, l.markup, s.naver.feeRate, variants)).filter((p) => selling.has(`${p.option}|${p.units}`)));
  if (!plans.length) throw new NaverSkip('수익 가능한 판매가를 만들 수 없음(스마트스토어 수수료 기준)');
  const base = [...plans].sort((a, b) => a.salePrice - b.salePrice)[0]!;
  const live = isLive(ctx.env, 'LIVE_LISTING');
  const now = ctx.clock.now();
  const row = await ctx.db.insertInto('listings').values({
    candidate_id: l.candidate_id,
    source_product_id: sp.id,
    market: 'naver',
    title: l.title,
    search_tags: JSON.stringify(l.search_tags),
    category_code: cat.id,
    category_name: cat.name,
    sale_price: base.salePrice,
    floor_price: base.floor,
    markup: l.markup,
    target_markup: l.target_markup,
    fee_rate_actual: s.naver.feeRate,
    source_option: l.source_option,
    images: JSON.stringify(srcImages),
    status: 'draft',
    dry_run: !live,
    created_at: now,
    updated_at: now,
  }).returningAll().executeTakeFirstOrThrow();
  try {
    await saveItems(ctx, row.id, plans);
    const items = await ctx.db.selectFrom('listing_items').selectAll().where('listing_id', '=', row.id).execute();
    const stockOf = (opt: string) => (opt ? d?.options?.find((o) => o.name === opt)?.stock ?? sp.stock : sp.stock) ?? null;
    let images = srcImages;
    let addr: { shipping?: number; ret?: number } = { shipping: s.naver.shippingAddressId || undefined, ret: s.naver.returnAddressId || undefined };
    if (live && ctx.naverApi) {
      images = await ctx.naverApi.uploadImages(srcImages);
      if (!images.length) throw new Error('스마트스토어 이미지 업로드 결과 없음');
      if (!addr.shipping || !addr.ret) addr = { ...(await addressBook(ctx)), ...Object.fromEntries(Object.entries(addr).filter(([, v]) => v)) };
    }
    const payload = buildNaverPayload(s, {
      title: l.title,
      categoryId: cat.id,
      items: items.map((it) => ({ id: it.id, units: it.unit_qty, option: it.source_option, salePrice: it.sale_price, stock: stockOf(it.source_option) })),
      images,
      detailHtml,
      detail: d,
      listingId: row.id,
      shippingAddressId: addr.shipping,
      returnAddressId: addr.ret,
    });
    const res = await marketFor(ctx, 'naver').createProduct(payload);
    const done = await ctx.db.updateTable('listings').set({ seller_product_id: res.sellerProductId, payload: JSON.stringify(payload), status: 'pending_approval', status_reason: null, updated_at: ctx.clock.now() })
      .where('id', '=', row.id).returningAll().executeTakeFirstOrThrow();
    await audit(ctx, 'system', 'naver.create', String(row.id), { coupangListing: l.id, originProductNo: res.sellerProductId, category: cat.name, score: Number(cat.score.toFixed(2)), options: items.length });
    return done;
  } catch (e) {
    await ctx.db.updateTable('listings').set({ status: 'rejected', status_reason: `스마트스토어 등록 실패: ${errMessage(e)}`.slice(0, 300), updated_at: ctx.clock.now() }).where('id', '=', row.id).execute();
    throw e;
  }
}

/** 등록 요청 형식 오류로 실패했던 상품(스마트스토어에 올라가지 않은 반려 행)을 지우고 재시도 메모를 비운다 — 버전당 한 번 */
async function resetOldFailures(ctx: AppContext): Promise<void> {
  if (((await ctx.kv.get<number>(RESET_KEY)) ?? 0) >= RESET_VERSION) return;
  const rows = await ctx.db.selectFrom('listings').select('id').where('market', '=', 'naver').where('status', '=', 'rejected')
    .where('seller_product_id', 'is', null).where('status_reason', 'like', '스마트스토어 등록 실패%')
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom('orders').select('orders.id').whereRef('orders.listing_id', '=', 'listings.id')))).execute();
  if (rows.length) await ctx.db.deleteFrom('listings').where('id', 'in', rows.map((r) => r.id)).execute();
  await ctx.kv.set('naver.skip', {});
  await ctx.kv.set(RESET_KEY, RESET_VERSION);
  if (rows.length) await audit(ctx, 'system', 'naver.reset', 'mirror', { removed: rows.length });
}

/** 스마트스토어 주소록의 첫 출고지·반품/교환지(하루 캐시) */
async function addressBook(ctx: AppContext): Promise<{ shipping?: number; ret?: number }> {
  const cached = await ctx.kv.get<{ at: string; shipping?: number; ret?: number }>('naver.addresses');
  if (cached && ctx.clock.now().getTime() - new Date(cached.at).getTime() < 86400_000) return { shipping: cached.shipping, ret: cached.ret };
  const p = await ctx.naverApi!.listShippingPlaces();
  const v = { shipping: Number(p.outbound[0]?.code) || undefined, ret: Number(p.returns[0]?.code) || undefined };
  await ctx.kv.set('naver.addresses', { at: ctx.clock.now().toISOString(), ...v });
  return v;
}
