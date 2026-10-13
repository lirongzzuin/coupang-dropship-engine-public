import { isLive } from '../../config/env.js';
import { type AppContext, audit } from '../../context.js';
import type { ListingRow } from '../../db/schema.js';
import { errMessage } from '../../lib/util.js';
import { detailOf } from '../catalog.js';
import { initialMarkup, targetMarkup, targetPrice } from '../pricing/pricing.js';
import { getItems, planItems, saveItems } from './items.js';
import { buildCoupangPayload } from './payload.js';
import { hostDetailHtml, prepareMainImages } from './media.js';
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
  // 출시 기간엔 낮은 가격(초기 판매·리뷰 확보), 이후 목표(하한가와 경쟁가의 중간 지점)로 → 최적화가 조정
  const markup = initialMarkup(s, tp.floor, cand.market_lowest);
  const target = targetMarkup(s, tp.floor, cand.market_lowest);
  const plans = await planItems(ctx, sp, title, markup);
  if (!plans.length) throw new ListingError('수익 가능한 판매가를 만들 수 없음');
  const now = ctx.clock.now();
  const row = await ctx.db
    .insertInto('listings')
    .values({
      candidate_id: cand.id,
      source_product_id: sp.id,
      market: ctx.market.name,
      title,
      search_tags: JSON.stringify(buildTags(title, cand.keyword, s.listing.bannedTerms, s.listing.maxTags)),
      sale_price: plans[0]!.salePrice,
      floor_price: plans[0]!.floor,
      markup,
      target_markup: target,
      images: JSON.stringify(images),
      status: 'draft',
      status_reason: images.length ? null : '이미지 필요(공급처 이미지 재사용 불가 → 직접 촬영/제작 이미지 업로드)',
      dry_run: true,
      created_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await saveItems(ctx, row.id, plans);
  await ctx.db.updateTable('candidates').set({ status: 'listed', decided_at: now }).where('id', '=', cand.id).execute();
  await audit(ctx, actor, 'listing.draft', String(row.id), { candidateId, markup, options: plans.map((p) => p.units) });
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
    // 1개 옵션 가격으로 마크업을 역산해 묶음 옵션 가격도 같은 비율로
    const markup = Math.max(0, patch.salePrice / l.floor_price - 1);
    const sp = await ctx.db.selectFrom('source_products').selectAll().where('id', '=', l.source_product_id).executeTakeFirstOrThrow();
    const plans = await planItems(ctx, sp, patch.title ?? l.title, markup, l.fee_rate_actual);
    if (plans[0]) plans[0].salePrice = patch.salePrice;
    if (l.status === 'draft' || l.status === 'rejected') await saveItems(ctx, l.id, plans);
    set.sale_price = patch.salePrice;
    set.markup = markup;
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
  // 실등록 모드에서는 모의(DRY_RUN) 등록분을 상한 계산에서 제외
  let activeQ = ctx.db.selectFrom('listings').select((eb) => eb.fn.countAll<number>().as('n')).where('status', 'in', ['active', 'pending_approval']);
  if (isLive(ctx.env, 'LIVE_LISTING')) activeQ = activeQ.where('dry_run', '=', false);
  const active = await activeQ.executeTakeFirst();
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
  let images = l.images as string[];
  let sourceHtml = d?.detailHtml;
  if (s.listing.convertImages && isLive(ctx.env, 'LIVE_LISTING') && !ctx.env.MEDIA_PUBLIC_BASE_URL) {
    throw new ListingError('이미지 공개 주소 미설정 — 쿠팡이 상품 이미지를 가져갈 수 없습니다. 터미널에서 bash ~/dropship/bin/media-public.sh 를 실행하세요');
  }
  if (s.listing.convertImages) {
    // 확장자 없는 URL·GIF·PNG → 흰 배경 .jpg(우리 서버 /media). 상세 이미지는 재사용 허용 상품만
    images = await prepareMainImages(ctx, images);
    if (!images.length) throw new ListingError('대표 이미지를 .jpg로 변환하지 못했습니다(공급처 이미지 확인 또는 직접 업로드)');
    if (sp.image_reuse_allowed && sourceHtml) sourceHtml = (await hostDetailHtml(ctx, sourceHtml)).html;
  }
  const detailHtml = buildDetailHtml({
    title: l.title,
    images,
    facts: [
      { name: '원산지', value: d?.origin ?? '' },
      { name: '제조사', value: d?.manufacturer ?? '' },
      ...(d?.kc?.certNo ? [{ name: 'KC 인증', value: d.kc.certNo }] : []),
    ],
    sourceHtml,
    reuseAllowed: sp.image_reuse_allowed,
  });
  // 옵션명은 현재 상품명 기준으로 다시 맞춘다(초안 수정 반영)
  const items = await getItems(ctx, l);
  const options = items.map((it) => ({ units: it.unit_qty, salePrice: it.sale_price, itemName: `${l!.title} ${it.unit_qty}개` }));
  for (const it of items) if (it.id) await ctx.db.updateTable('listing_items').set({ item_name: `${l.title} ${it.unit_qty}개` }).where('id', '=', it.id).execute();
  const payload = buildCoupangPayload(s, {
    vendorId: ctx.env.COUPANG_VENDOR_ID ?? 'A00000000',
    title: l.title,
    categoryCode,
    options,
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
  // 실등록으로 전환되면 모의 등록분은 정리(실제 쿠팡에 없는 상품)
  if (isLive(ctx.env, 'LIVE_LISTING')) {
    await ctx.db.updateTable('listings').set({ status: 'stopped', status_reason: '모의 등록분 정리(실운영 전환)', updated_at: ctx.clock.now() })
      .where('dry_run', '=', true).where('status', 'in', ['active', 'pending_approval', 'paused']).execute();
  }
  const pending = await ctx.db.selectFrom('listings').selectAll().where('status', '=', 'pending_approval').execute();
  let approved = 0, rejected = 0;
  for (const l of pending) {
    if (!l.seller_product_id) continue;
    try {
      const st = await ctx.market.getProductStatus(l.seller_product_id);
      if (st.status === 'APPROVED' && st.vendorItemIds.length) {
        // 옵션명으로 옵션ID 매칭(없으면 등록 순서)
        const items = await ctx.db.selectFrom('listing_items').selectAll().where('listing_id', '=', l.id).orderBy('unit_qty').execute();
        const named = st.items ?? [];
        items.forEach((it, idx) => {
          it.vendor_item_id = named.find((n) => n.itemName === it.item_name)?.vendorItemId ?? st.vendorItemIds[idx] ?? null;
        });
        for (const it of items) await ctx.db.updateTable('listing_items').set({ vendor_item_id: it.vendor_item_id }).where('id', '=', it.id).execute();
        const base = items.find((i) => i.unit_qty === 1)?.vendor_item_id ?? st.vendorItemIds[0]!;
        await ctx.db.updateTable('listings').set({ status: 'active', vendor_item_id: base, listed_at: ctx.clock.now(), price_set_at: ctx.clock.now(), updated_at: ctx.clock.now() }).where('id', '=', l.id).execute();
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

/**
 * 공급처 상품 견적: 쿠팡에 직접(수동) 등록할 때 쓸 상품명·판매가·이미지·고시정보를 계산.
 * (쿠팡 API 키 발급 전 첫 상품을 Wing에서 등록할 때 사용)
 */
export async function quoteSourceItem(ctx: AppContext, source: string, sourceItemId: string) {
  const s = await ctx.settings.get();
  const src = ctx.sources.get(source);
  if (!src) throw new ListingError(`등록되지 않은 공급처: ${source} (.env 에 해당 공급처 키를 넣었는지 확인)`);
  const d = await src.getProduct(sourceItemId.trim());
  if (!d) throw new ListingError('공급처에서 상품을 찾을 수 없습니다(상품코드 확인)');
  const { upsertSourceProduct } = await import('../catalog.js');
  await upsertSourceProduct(ctx, source, d);
  const tp = targetPrice(s, { cost: d.price, shipping: d.shippingFee, categoryPath: d.categoryPath, inputVatDeductible: d.taxInvoice, minResalePrice: d.minResalePrice });
  const title = sanitizeTitle(d.title, s.listing.bannedTerms, s.listing.maxTitleLength);
  const spRow = await ctx.db.selectFrom('source_products').selectAll().where('source', '=', source).where('source_item_id', '=', d.sourceItemId).executeTakeFirstOrThrow();
  const plans = tp.feasible ? await planItems(ctx, spRow, title, s.pricing.defaultMarkup) : [];
  const { computeProfit } = await import('../pricing/pricing.js');
  return {
    options: plans.map((p) => ({ units: p.units, itemName: p.itemName, salePrice: p.salePrice, floor: p.floor,
      profit: computeProfit(s, p.salePrice, { cost: d.price * p.units, shipping: d.shippingPerUnit ? d.shippingFee * p.units : d.shippingFee, categoryPath: d.categoryPath, inputVatDeductible: d.taxInvoice }).profit })),
    source,
    sourceItemId: d.sourceItemId,
    sourceUrl: d.url,
    status: d.status,
    stock: d.stock,
    supplyPrice: d.price,
    shippingFee: d.shippingFee,
    minResalePrice: d.minResalePrice ?? null,
    suggestedTitle: title,
    suggestedTags: buildTags(title, '', s.listing.bannedTerms, s.listing.maxTags),
    salePrice: plans[0]?.salePrice ?? null,
    floorPrice: tp.feasible ? tp.floor : null,
    profit: plans[0] ? (await import('../pricing/pricing.js')).computeProfit(s, plans[0].salePrice, { cost: d.price, shipping: d.shippingFee, categoryPath: d.categoryPath, inputVatDeductible: d.taxInvoice }) : null,
    images: d.imageReuseAllowed ? d.images : [],
    imageReuseAllowed: d.imageReuseAllowed,
    prepDays: (d.prepDays ?? 1) + s.listing.shippingBufferDays,
    notice: d.notice ?? null,
    kc: d.kc ?? null,
    apiOrder: src.capabilities.apiOrder,
  };
}

/**
 * 쿠팡에 이미 등록된 상품(Wing에서 직접 등록한 것 포함)을 공급처 상품과 연결.
 * 연결 후에는 주문 자동 처리·가격/재고 동기화가 똑같이 적용된다.
 */
export async function linkExistingListing(
  ctx: AppContext,
  input: { vendorItemId: string; sellerProductId?: string; salePrice: number; source: string; sourceItemId: string; title?: string },
  actor: string,
): Promise<{ listing: ListingRow; warning: string | null }> {
  const s = await ctx.settings.get();
  const vendorItemId = input.vendorItemId.trim();
  if (!/^\d+$/.test(vendorItemId) && !ctx.env.DEMO_MODE && ctx.env.MARKET_ADAPTER === 'coupang') throw new ListingError('옵션ID(vendorItemId)는 숫자입니다. Wing > 상품조회/수정에서 확인하세요');
  const { findByVendorItem } = await import('./items.js');
  const dupItem = await findByVendorItem(ctx, vendorItemId);
  if (dupItem && !['stopped', 'rejected'].includes(dupItem.listing.status)) throw new ListingError(`이미 연결된 옵션ID입니다(상품 #${dupItem.listing.id})`);
  const dup = await ctx.db.selectFrom('listings').select('id').where('vendor_item_id', '=', vendorItemId).where('status', 'not in', ['stopped', 'rejected']).executeTakeFirst();
  if (dup) throw new ListingError(`이미 연결된 옵션ID입니다(상품 #${dup.id})`);
  const src = ctx.sources.get(input.source);
  if (!src) throw new ListingError(`등록되지 않은 공급처: ${input.source}`);
  const d = await src.getProduct(input.sourceItemId.trim());
  if (!d) throw new ListingError('공급처에서 상품을 찾을 수 없습니다');
  const { upsertSourceProduct } = await import('../catalog.js');
  const sp = await upsertSourceProduct(ctx, input.source, d);
  const tp = targetPrice(s, { cost: d.price, shipping: d.shippingFee, categoryPath: d.categoryPath, inputVatDeductible: d.taxInvoice, minResalePrice: d.minResalePrice });
  const floor = tp.feasible ? tp.floor : input.salePrice;
  const now = ctx.clock.now();
  const listing = await ctx.db
    .insertInto('listings')
    .values({
      source_product_id: sp.id,
      market: ctx.market.name,
      seller_product_id: input.sellerProductId?.trim() || null,
      vendor_item_id: vendorItemId,
      title: input.title?.trim() || d.title,
      search_tags: JSON.stringify([]),
      sale_price: input.salePrice,
      floor_price: floor,
      markup: Math.max(0, input.salePrice / floor - 1),
      price_set_at: now,
      images: JSON.stringify(d.imageReuseAllowed ? d.images : []),
      status: 'active',
      status_reason: '기존 쿠팡 상품 연결',
      dry_run: false,
      created_at: now,
      updated_at: now,
      listed_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(ctx, actor, 'listing.link', String(listing.id), input);
  const warning = !tp.feasible
    ? '이 상품은 설정한 최소 이익 기준을 맞출 수 없습니다. 주문이 들어오면 손익을 확인하세요.'
    : input.salePrice < tp.floor
      ? `현재 판매가(${input.salePrice.toLocaleString()}원)가 최소 이익 기준 판매가(${tp.floor.toLocaleString()}원)보다 낮습니다. 가격 동기화(LIVE_PRICING)를 켜면 자동으로 올립니다.`
      : null;
  return { listing, warning };
}
