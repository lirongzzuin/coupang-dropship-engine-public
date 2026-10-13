import { isLive } from '../../config/env.js';
import { type AppContext, audit } from '../../context.js';
import type { ListingRow } from '../../db/schema.js';
import { errMessage } from '../../lib/util.js';
import { detailOf } from '../catalog.js';
import { targetPrice } from '../pricing/pricing.js';
import { buildCoupangPayload } from './payload.js';
import { buildDetailHtml, buildTags, findBannedTerms, sanitizeTitle } from './text.js';

export class ListingError extends Error {}

/** 후보 → 등록 초안 */
export async function createDraftFromCandidate(ctx: AppContext, candidateId: number, actor = 'system'): Promise<ListingRow> {
  const s = await ctx.settings.get();
  const cand = await ctx.db.selectFrom('candidates').selectAll().where('id', '=', candidateId).executeTakeFirst();
  if (!cand) throw new ListingError('후보 없음');
  const existing = await ctx.db.selectFrom('listings').selectAll().where('source_product_id', '=', cand.source_product_id).where('status', 'not in', ['stopped', 'rejected']).executeTakeFirst();
  if (existing) return existing;
  const sp = await ctx.db.selectFrom('source_products').selectAll().where('id', '=', cand.source_product_id).executeTakeFirstOrThrow();
  const d = detailOf(sp);
  const title = sanitizeTitle(sp.title, s.listing.bannedTerms, s.listing.maxTitleLength);
  const tp = targetPrice(s, { cost: sp.price, shipping: sp.shipping_fee, categoryPath: sp.category_path, inputVatDeductible: sp.tax_invoice, minResalePrice: sp.min_resale_price });
  if (!tp.feasible) throw new ListingError('수익 가능한 판매가를 만들 수 없음');
  const images = sp.image_reuse_allowed ? (d?.images?.length ? d.images : sp.image_url ? [sp.image_url] : []) : [];
  const now = ctx.clock.now();
  const row = await ctx.db
    .insertInto('listings')
    .values({
      candidate_id: cand.id,
      source_product_id: sp.id,
      market: ctx.market.name,
      title,
      search_tags: JSON.stringify(buildTags(title, cand.keyword, s.listing.bannedTerms, s.listing.maxTags)),
      sale_price: Math.max(tp.price, cand.target_price ?? 0),
      floor_price: tp.floor,
      images: JSON.stringify(images),
      status: 'draft',
      status_reason: images.length ? null : '이미지 필요(공급처 이미지 재사용 불가 → 직접 촬영/제작 이미지 업로드)',
      dry_run: true,
      created_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await ctx.db.updateTable('candidates').set({ status: 'listed', decided_at: now }).where('id', '=', cand.id).execute();
  await audit(ctx, actor, 'listing.draft', String(row.id), { candidateId });
  return row;
}

export async function updateDraft(ctx: AppContext, id: number, patch: { title?: string; salePrice?: number; images?: string[]; categoryCode?: string; tags?: string[] }, actor: string): Promise<ListingRow> {
  const s = await ctx.settings.get();
  const l = await ctx.db.selectFrom('listings').selectAll().where('id', '=', id).executeTakeFirst();
  if (!l) throw new ListingError('등록 상품 없음');
  const set: Record<string, unknown> = { updated_at: ctx.clock.now() };
  if (patch.title !== undefined) set.title = sanitizeTitle(patch.title, s.listing.bannedTerms, s.listing.maxTitleLength);
  if (patch.salePrice !== undefined) {
    if (patch.salePrice < l.floor_price) throw new ListingError(`하한가(${l.floor_price.toLocaleString()}원) 미만으로 설정할 수 없습니다`);
    set.sale_price = patch.salePrice;
  }
  if (patch.images !== undefined) {
    set.images = JSON.stringify(patch.images);
    if (patch.images.length && l.status_reason?.startsWith('이미지 필요')) set.status_reason = null;
  }
  if (patch.categoryCode !== undefined) set.category_code = patch.categoryCode;
  if (patch.tags !== undefined) set.search_tags = JSON.stringify(patch.tags.slice(0, s.listing.maxTags));
  await audit(ctx, actor, 'listing.update', String(id), patch);
  return ctx.db.updateTable('listings').set(set).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
}

/** 등록 전 검증. 문제 목록 반환(빈 배열이면 통과) */
export async function validateListing(ctx: AppContext, l: ListingRow): Promise<string[]> {
  const s = await ctx.settings.get();
  const problems: string[] = [];
  const images = (l.images as string[]) ?? [];
  if (!images.length) problems.push('대표 이미지가 없습니다');
  const banned = findBannedTerms(`${l.title} ${(l.search_tags as string[]).join(' ')}`, s.listing.bannedTerms);
  if (banned.length) problems.push(`금지 문구 포함: ${banned.join(', ')}`);
  if (!l.title.trim()) problems.push('상품명이 비었습니다');
  if (l.sale_price < l.floor_price) problems.push('판매가가 하한가보다 낮습니다');
  if (isLive(ctx.env, 'LIVE_LISTING')) {
    const c = s.coupang;
    const missing = (['vendorUserId', 'outboundShippingPlaceCode', 'returnCenterCode', 'companyContactNumber', 'returnZipCode', 'returnAddress'] as const).filter((k) => !c[k]);
    if (missing.length) problems.push(`설정 > 쿠팡 정보 미입력: ${missing.join(', ')}`);
  }
  const active = await ctx.db.selectFrom('listings').select((eb) => eb.fn.countAll<number>().as('n')).where('status', 'in', ['active', 'pending_approval']).executeTakeFirst();
  if (Number(active?.n ?? 0) >= s.listing.maxActiveListings && l.status === 'draft') problems.push(`운영 상품 수 상한(${s.listing.maxActiveListings}) 도달`);
  return problems;
}

export async function registerListing(ctx: AppContext, id: number, actor = 'system'): Promise<ListingRow> {
  const s = await ctx.settings.get();
  if (s.killSwitch) throw new ListingError('긴급 정지 중입니다');
  let l = await ctx.db.selectFrom('listings').selectAll().where('id', '=', id).executeTakeFirst();
  if (!l) throw new ListingError('등록 상품 없음');
  if (l.status !== 'draft' && l.status !== 'rejected') throw new ListingError(`등록할 수 없는 상태: ${l.status}`);
  const problems = await validateListing(ctx, l);
  if (problems.length) throw new ListingError(problems.join(' / '));
  const sp = await ctx.db.selectFrom('source_products').selectAll().where('id', '=', l.source_product_id).executeTakeFirstOrThrow();
  const d = detailOf(sp);

  let categoryCode = l.category_code;
  let categoryName = l.category_name;
  if (!categoryCode) {
    const pred = await ctx.market.predictCategory(l.title);
    if (!pred) throw new ListingError('카테고리 추천 실패 — 카테고리 코드를 직접 입력하세요');
    categoryCode = pred.code;
    categoryName = pred.name;
  }
  const meta = await ctx.market.getCategoryMeta(categoryCode);
  const images = l.images as string[];
  const detailHtml = buildDetailHtml({
    title: l.title,
    images,
    facts: [
      { name: '원산지', value: d?.origin ?? '' },
      { name: '제조사', value: d?.manufacturer ?? '' },
      ...(d?.kc?.certNo ? [{ name: 'KC 인증', value: d.kc.certNo }] : []),
    ],
    sourceHtml: d?.detailHtml,
    reuseAllowed: sp.image_reuse_allowed,
  });
  const payload = buildCoupangPayload(s, {
    vendorId: ctx.env.COUPANG_VENDOR_ID ?? 'A00000000',
    title: l.title,
    categoryCode,
    salePrice: l.sale_price,
    originalPrice: Math.round(l.sale_price * s.pricing.originalPriceMultiplier),
    stock: Math.min(sp.stock ?? 999, 999),
    images,
    detailHtml,
    tags: l.search_tags as string[],
    meta,
    detail: d,
    sourceProductId: sp.id,
    now: ctx.clock.now(),
  });
  try {
    const res = await ctx.market.createProduct(payload);
    l = await ctx.db
      .updateTable('listings')
      .set({
        seller_product_id: res.sellerProductId,
        category_code: categoryCode,
        category_name: categoryName,
        detail_html: detailHtml,
        payload: JSON.stringify(payload),
        status: 'pending_approval',
        status_reason: null,
        dry_run: !!res.dryRun,
        updated_at: ctx.clock.now(),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(ctx, actor, 'listing.register', String(id), { sellerProductId: res.sellerProductId, dryRun: !!res.dryRun });
    return l;
  } catch (e) {
    await ctx.db.updateTable('listings').set({ status_reason: `등록 실패: ${errMessage(e)}`.slice(0, 500), updated_at: ctx.clock.now() }).where('id', '=', id).execute();
    throw new ListingError(`쿠팡 등록 실패: ${errMessage(e)}`);
  }
}

/** 심사 상태 추적 → 승인 시 vendorItemId 확보·active */
export async function refreshListingStatuses(ctx: AppContext): Promise<{ approved: number; rejected: number }> {
  const pending = await ctx.db.selectFrom('listings').selectAll().where('status', '=', 'pending_approval').execute();
  let approved = 0, rejected = 0;
  for (const l of pending) {
    if (!l.seller_product_id) continue;
    try {
      const st = await ctx.market.getProductStatus(l.seller_product_id);
      if (st.status === 'APPROVED' && st.vendorItemIds.length) {
        await ctx.db.updateTable('listings').set({ status: 'active', vendor_item_id: st.vendorItemIds[0]!, listed_at: ctx.clock.now(), updated_at: ctx.clock.now() }).where('id', '=', l.id).execute();
        approved++;
        await ctx.notifications.notify('info', '상품 판매 시작', `${l.title} (${l.sale_price.toLocaleString()}원)`, { path: `/listings` });
      } else if (st.status === 'REJECTED') {
        await ctx.db.updateTable('listings').set({ status: 'rejected', status_reason: `쿠팡 승인 반려(${st.rawStatus}) — Wing에서 사유 확인`, updated_at: ctx.clock.now() }).where('id', '=', l.id).execute();
        rejected++;
        await ctx.notifications.notify('warn', '상품 승인 반려', `${l.title}: Wing에서 반려 사유를 확인하세요.`, { path: `/listings` });
      }
    } catch (e) {
      ctx.log.warn({ listing: l.id, err: errMessage(e) }, '상품 상태 조회 실패');
    }
  }
  return { approved, rejected };
}
