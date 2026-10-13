import type { AppContext } from '../../context.js';
import { addDays, errMessage } from '../../lib/util.js';
import { upsertSourceProduct } from '../catalog.js';
import { createDraftFromCandidate, registerListing } from '../listing/service.js';
import { targetPrice } from '../pricing/pricing.js';
import { evaluateGates, type KeywordSignals, monthlySlope, scoreCandidate } from './scoring.js';

/**
 * 상품 선정 파이프라인: 키워드 → 시장 신호 → 공급처 후보 → 게이트 → 점수 → (auto) 자동 등록
 */
export async function collectSignals(ctx: AppContext, keywords: string[]): Promise<Record<string, KeywordSignals>> {
  const now = ctx.clock.now();
  const out: Record<string, KeywordSignals> = {};
  const save = async (keyword: string, kind: string, value: number, meta?: unknown) => {
    await ctx.db.insertInto('market_signals').values({ keyword, kind, value, meta: meta === undefined ? null : JSON.stringify(meta), at: now }).execute();
  };
  let volumes: Record<string, number> | null = null;
  try {
    volumes = await ctx.marketData.monthlySearchVolume(keywords);
  } catch (e) {
    ctx.log.warn({ err: errMessage(e) }, '검색량 조회 실패(무시)');
  }
  for (const kw of keywords) {
    const sig: KeywordSignals = {};
    const vol = volumes?.[kw] ?? volumes?.[kw.replace(/\s+/g, '')];
    if (vol !== undefined) {
      sig.searchVolume = vol;
      await save(kw, 'search_volume', vol);
    }
    try {
      const trend = await ctx.marketData.weeklyTrend(kw, 12);
      if (trend?.length) {
        sig.trend = trend;
        await save(kw, 'trend_12w', trend[trend.length - 1] ?? 0, trend);
      }
    } catch (e) {
      ctx.log.warn({ kw, err: errMessage(e) }, '트렌드 조회 실패(무시)');
    }
    try {
      const shop = await ctx.marketData.shoppingSearch(kw);
      if (shop) {
        const prices = shop.items.map((i) => i.price).filter((p) => p > 0).sort((a, b) => a - b);
        sig.naverCount = shop.total;
        sig.naverMalls = new Set(shop.items.map((i) => i.mall)).size;
        if (prices.length) sig.naverLowest = prices[0];
        await save(kw, 'naver_count', shop.total);
        if (sig.naverLowest) await save(kw, 'naver_lowest', sig.naverLowest, { p25: prices[Math.floor(prices.length / 4)] });
      }
    } catch (e) {
      ctx.log.warn({ kw, err: errMessage(e) }, '쇼핑검색 실패(무시)');
    }
    // 검색량 이력(매일 저장) → 월별 추이: 데이터랩이 없어도 추세 확보
    if (!sig.trend) {
      const hist = await ctx.db.selectFrom('market_signals').select(['at', 'value']).where('keyword', '=', kw).where('kind', '=', 'search_volume').where('at', '>=', addDays(now, -150)).execute();
      const slope = monthlySlope(hist.map((h) => ({ at: new Date(h.at), value: h.value })));
      if (slope !== undefined) sig.volumeSlope = slope;
    }
    // 구글 트렌드(보조)
    if (ctx.marketData.googleTrend) {
      try {
        const g = await ctx.marketData.googleTrend(kw);
        if (g?.length) {
          sig.googleTrend = g;
          await save(kw, 'google_trend', g[g.length - 1] ?? 0, g);
        }
      } catch (e) {
        ctx.log.warn({ kw, err: errMessage(e) }, '구글 트렌드 실패(무시)');
      }
    }
    // 쿠팡 검색 상위 가격(쿠팡 파트너스, 선택)
    if (ctx.marketData.coupangSearch) {
      try {
        const c = await ctx.marketData.coupangSearch(kw);
        if (c) {
          sig.coupangLowest = c.lowest;
          sig.coupangRocketRatio = c.rocketRatio;
          await save(kw, 'coupang_lowest', c.lowest, { median: c.median, count: c.count });
          await save(kw, 'coupang_rocket_ratio', c.rocketRatio);
        }
      } catch (e) {
        ctx.log.warn({ kw, err: errMessage(e) }, '쿠팡 파트너스 실패(무시)');
      }
    }
    // 최근 7일 내 저장된 쿠팡 최저가(직접 조회 실패·한도 초과 시 재사용)
    if (sig.coupangLowest === undefined) {
      const cl = await ctx.db.selectFrom('market_signals').select('value').where('keyword', '=', kw).where('kind', '=', 'coupang_lowest').where('at', '>=', addDays(now, -7)).orderBy('at', 'desc').executeTakeFirst();
      if (cl) sig.coupangLowest = cl.value;
    }
    // 수동 임포트한 쿠팡 판매량 추정치(최근 30일 내)
    const est = await ctx.db.selectFrom('market_signals').select('value').where('keyword', '=', kw).where('kind', '=', 'coupang_sales_est').where('at', '>=', addDays(now, -30)).orderBy('at', 'desc').executeTakeFirst();
    if (est) sig.coupangSalesEst = est.value;
    out[kw] = sig;
  }
  return out;
}

/** 잘 팔리는 상품의 키워드를 자동으로 시드에 추가(최근 14일 주문 3건 이상) */
async function winnerKeywords(ctx: AppContext): Promise<string[]> {
  const since = addDays(ctx.clock.now(), -14);
  const rows = await ctx.db
    .selectFrom('orders')
    .innerJoin('listings', 'listings.id', 'orders.listing_id')
    .innerJoin('candidates', 'candidates.id', 'listings.candidate_id')
    .select(['candidates.keyword as keyword', (eb) => eb.fn.countAll<number>().as('n')])
    .where('orders.ordered_at', '>=', since)
    .groupBy('candidates.keyword')
    .having((eb) => eb.fn.countAll(), '>=', 3)
    .execute();
  return rows.map((r) => r.keyword);
}

/** 네이버 검색광고 연관 키워드로 시드 확장(검색량 범위·경쟁도·금지어 필터) */
export async function expandKeywords(ctx: AppContext, seeds: string[]): Promise<string[]> {
  const s = await ctx.settings.get();
  const n = s.selection.expandRelatedPerSeed;
  if (n <= 0 || !ctx.marketData.relatedKeywords) return [];
  const out: string[] = [];
  const blocked = [...s.selection.blockedKeywords, ...s.selection.blockedCategoryKeywords];
  for (const seed of seeds) {
    try {
      const rel = (await ctx.marketData.relatedKeywords(seed)) ?? [];
      const picked = rel
        .filter((r) => r.volume >= s.selection.relatedMinVolume && r.volume <= s.selection.relatedMaxVolume)
        .filter((r) => !(s.selection.relatedExcludeHighCompetition && r.competition === '높음'))
        .filter((r) => !blocked.some((b) => b && r.keyword.includes(b)))
        .sort((a, b) => b.volume - a.volume)
        .slice(0, n);
      for (const r of picked) {
        out.push(r.keyword);
        await ctx.db.insertInto('market_signals').values({ keyword: r.keyword, kind: 'related_of', value: r.volume, meta: JSON.stringify({ seed, competition: r.competition }), at: ctx.clock.now() }).execute();
      }
    } catch (e) {
      ctx.log.warn({ seed, err: errMessage(e) }, '연관 키워드 확장 실패(무시)');
    }
  }
  return out;
}

export interface SelectionResult {
  runId: string;
  keywords: number;
  evaluated: number;
  passed: number;
  autoListed: number;
  errors: string[];
}

export async function runSelection(ctx: AppContext, opts: { keywords?: string[] } = {}): Promise<SelectionResult> {
  const s = await ctx.settings.get();
  const runId = `run-${ctx.clock.now().getTime()}`;
  const seeds = [...new Set([...(opts.keywords ?? s.selection.seedKeywords), ...(opts.keywords ? [] : await winnerKeywords(ctx))].map((k) => k.trim()).filter(Boolean))];
  const keywords = [...new Set([...seeds, ...(await expandKeywords(ctx, seeds))])];
  const result: SelectionResult = { runId, keywords: keywords.length, evaluated: 0, passed: 0, autoListed: 0, errors: [] };
  if (!keywords.length) return result;
  const signals = await collectSignals(ctx, keywords);
  const sources = s.selection.sources.map((id) => ctx.sources.get(id)).filter((x): x is NonNullable<typeof x> => !!x && x.capabilities.search);

  for (const kw of keywords) {
    for (const src of sources) {
      let found;
      try {
        found = await src.search(kw, { limit: s.selection.perKeywordLimit, minPrice: s.selection.minSupplyPrice, maxPrice: s.selection.maxSupplyPrice });
      } catch (e) {
        result.errors.push(`${src.id}/${kw}: ${errMessage(e)}`);
        continue;
      }
      for (const item of found) {
        try {
          const d = src.capabilities.detail ? await src.getProduct(item.sourceItemId, { title: item.title }) : null;
          if (!d) continue;
          const sp = await upsertSourceProduct(ctx, src.id, d);
          const already = await ctx.db.selectFrom('listings').select('id').where('source_product_id', '=', sp.id).where('status', 'not in', ['stopped', 'rejected']).executeTakeFirst();
          if (already) continue;
          const tp = targetPrice(s, { cost: d.price, shipping: d.shippingFee, categoryPath: d.categoryPath, inputVatDeductible: d.taxInvoice, minResalePrice: d.minResalePrice });
          const apiOrder = src.capabilities.apiOrder;
          // 시장 최저가에서 자기 자신(같은 상품) 제외는 네이버 소스일 때만 의미가 있음
          const sig = { ...signals[kw] };
          const gates = evaluateGates(s, d, tp, sig, { apiOrder });
          const passed = gates.every((g) => !g.hard || g.pass);
          const { score, parts } = scoreCandidate(s, d, tp, sig, { apiOrder });
          result.evaluated++;
          if (passed) result.passed++;
          await ctx.db.insertInto('candidates').values({
            source_product_id: sp.id,
            keyword: kw,
            score,
            signals: JSON.stringify({ ...sig, trend: undefined, parts }),
            gates: JSON.stringify(gates),
            passed,
            target_price: tp.feasible ? tp.price : null,
            est_profit: tp.breakdown?.profit ?? null,
            est_margin: tp.breakdown?.margin ?? null,
            market_lowest: sig.naverLowest ?? null,
            status: 'new',
            run_id: runId,
            created_at: ctx.clock.now(),
          }).execute();
        } catch (e) {
          result.errors.push(`${src.id}/${item.sourceItemId}: ${errMessage(e)}`);
        }
      }
    }
  }

  // 이전 실행의 미결정 후보는 만료
  await ctx.db.updateTable('candidates').set({ status: 'expired' }).where('status', '=', 'new').where('run_id', '!=', runId).execute();

  if (s.selection.mode === 'auto' && !s.killSwitch) {
    result.autoListed = await autoList(ctx, runId);
  } else {
    const top = await ctx.db.selectFrom('candidates').innerJoin('source_products', 'source_products.id', 'candidates.source_product_id')
      .select(['candidates.id', 'source_products.title', 'candidates.score', 'candidates.est_profit'])
      .where('run_id', '=', runId).where('passed', '=', true).orderBy('score', 'desc').limit(s.selection.topNotify).execute();
    if (top.length) {
      await ctx.notifications.notify('action', `상품 후보 ${result.passed}개`, top.map((t, i) => `${i + 1}. ${t.title} (점수 ${t.score}, 이익 ${t.est_profit?.toLocaleString()}원)`).join('\n'), { path: '/candidates' });
    }
  }
  return result;
}

/** auto 모드: 무인 운영 조건을 만족하는 상위 후보만 자동 등록 */
async function autoList(ctx: AppContext, runId: string): Promise<number> {
  const s = await ctx.settings.get();
  const rows = await ctx.db
    .selectFrom('candidates')
    .innerJoin('source_products', 'source_products.id', 'candidates.source_product_id')
    .select(['candidates.id', 'candidates.score', 'source_products.source', 'source_products.image_reuse_allowed', 'source_products.title'])
    .where('run_id', '=', runId)
    .where('passed', '=', true)
    .where('candidates.status', '=', 'new')
    .where('score', '>=', s.selection.autoListMinScore)
    .orderBy('score', 'desc')
    .execute();
  let listed = 0;
  const seenProducts = new Set<string>();
  for (const r of rows) {
    if (listed >= s.selection.autoListPerRun) break;
    if (!r.image_reuse_allowed) continue; // 이미지 직접 제작 필요 → 사람 몫
    const src = ctx.sources.get(r.source);
    if (s.selection.autoListRequiresApiOrder && !src?.capabilities.apiOrder) continue;
    if (seenProducts.has(r.title)) continue;
    seenProducts.add(r.title);
    try {
      const draft = await createDraftFromCandidate(ctx, r.id, 'auto');
      await registerListing(ctx, draft.id, 'auto');
      listed++;
    } catch (e) {
      const msg = errMessage(e);
      ctx.log.warn({ candidate: r.id, err: msg }, '자동 등록 실패');
      if (msg.includes('쿠팡 정보 미입력')) {
        await ctx.notifications.notify('error', '자동 등록 중단: 설정 필요', `${msg}\n설정 화면에서 쿠팡 판매자 정보를 입력하면 다음 선정 주기에 자동 등록됩니다.`, { path: '/settings', dedupeKey: 'autolist-settings', dedupeMinutes: 24 * 60 });
        break;
      }
      if (msg.includes('상한')) break;
    }
  }
  if (listed) await ctx.notifications.notify('info', `상품 ${listed}개 자동 등록`, '쿠팡 승인 후 판매가 시작됩니다.', { path: '/listings' });
  return listed;
}

export async function decideCandidate(ctx: AppContext, id: number, approve: boolean, actor: string): Promise<{ listingId?: number }> {
  if (!approve) {
    await ctx.db.updateTable('candidates').set({ status: 'rejected', decided_at: ctx.clock.now() }).where('id', '=', id).execute();
    return {};
  }
  const draft = await createDraftFromCandidate(ctx, id, actor);
  await ctx.db.updateTable('candidates').set({ status: 'listed', decided_at: ctx.clock.now() }).where('id', '=', id).execute();
  return { listingId: draft.id };
}
