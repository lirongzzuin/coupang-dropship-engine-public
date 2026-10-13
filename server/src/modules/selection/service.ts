import type { AppContext } from '../../context.js';
import { addDays, errMessage } from '../../lib/util.js';
import { upsertSourceProduct } from '../catalog.js';
import { createDraftFromCandidate, registerListing } from '../listing/service.js';
import { pickKeywordsForRun, recordKeywordResults } from '../keywords/service.js';
import { targetPrice } from '../pricing/pricing.js';
import { DEFAULT_MODEL, expectedMonthly, keywordMatches, learnedFactor, looksBranded, looksBulk, median, productFamily, profitScore } from './demandModel.js';
import { evaluateGates, type KeywordSignals, marketReference, monthlySlope, scoreCandidate, trendSlope } from './scoring.js';

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
  const fresh = keywords.length
    ? await ctx.db.selectFrom('keywords').select(['keyword', 'volume']).where('keyword', 'in', keywords).where('last_checked_at', '>=', addDays(now, -7)).where('volume', 'is not', null).execute()
    : [];
  const known = Object.fromEntries(fresh.map((r) => [r.keyword, r.volume as number]));
  const missing = keywords.filter((k) => known[k] === undefined);
  try {
    volumes = { ...known, ...(missing.length ? ((await ctx.marketData.monthlySearchVolume(missing)) ?? {}) : {}) };
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
        sig.marketCount = shop.total;
        sig.marketSellers = new Set(shop.items.map((i) => i.mall)).size;
        sig.marketSource = shop.source;
        // 극단적 저가(액세서리·부품) 오염을 줄이려고 하위 10% 지점을 최저가로 사용
        if (prices.length) sig.marketLowest = prices[Math.floor(prices.length * 0.1)];
        await save(kw, 'market_count', shop.total, { source: shop.source });
        if (sig.marketLowest) await save(kw, 'market_lowest', sig.marketLowest, { source: shop.source, min: prices[0], p25: prices[Math.floor(prices.length / 4)] });
      }
    } catch (e) {
      ctx.log.warn({ kw, err: errMessage(e) }, '오픈마켓 검색 실패(무시)');
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
    const rv = await ctx.db.selectFrom('market_signals').select('value').where('keyword', '=', kw).where('kind', '=', 'coupang_reviews').where('at', '>=', addDays(now, -30)).orderBy('at', 'desc').executeTakeFirst();
    if (rv) sig.coupangReviews = rv.value;
    out[kw] = sig;
  }
  return out;
}

/** 잘 팔리는 상품의 키워드를 자동으로 시드에 추가(최근 14일 주문 3건 이상) */
/**
 * 학습 데이터: 실제로 올린 상품(모의 등록 제외)의 판매 vs 기대 판매를 키워드·카테고리별로 합산.
 * 기대 판매 = 선정 당시 수요 모델의 월판매 × 운영 개월 수. 등록 7일 미만은 판단 보류.
 */
export async function learnedHistory(ctx: AppContext): Promise<{ byKeyword: Map<string, { orders: number; expected: number }>; byCategory: Map<string, { orders: number; expected: number }> }> {
  const now = ctx.clock.now().getTime();
  const rows = await ctx.db.selectFrom('listings').innerJoin('candidates', 'candidates.id', 'listings.candidate_id')
    .select(['listings.id', 'listings.listed_at', 'listings.status', 'listings.updated_at', 'candidates.keyword', 'candidates.signals'])
    .where('listings.dry_run', '=', false).where('listings.listed_at', 'is not', null).execute();
  const counts = rows.length
    ? await ctx.db.selectFrom('orders').select(['listing_id', (eb) => eb.fn.countAll<number>().as('n')])
      .where('listing_id', 'in', rows.map((r) => r.id)).where('status', 'not in', ['CANCELLED']).groupBy('listing_id').execute()
    : [];
  const orders = new Map(counts.map((c) => [c.listing_id, Number(c.n)]));
  const byKeyword = new Map<string, { orders: number; expected: number }>();
  const byCategory = new Map<string, { orders: number; expected: number }>();
  const add = (m: Map<string, { orders: number; expected: number }>, k: string, o: number, e: number) => {
    const cur = m.get(k) ?? { orders: 0, expected: 0 };
    m.set(k, { orders: cur.orders + o, expected: cur.expected + e });
  };
  for (const r of rows) {
    const end = r.status === 'stopped' ? new Date(r.updated_at).getTime() : now;
    const months = (end - new Date(r.listed_at!).getTime()) / (30 * 86400_000);
    if (months < 0.25) continue;
    const sig = (typeof r.signals === 'string' ? JSON.parse(r.signals) : r.signals) as { demand?: { sales?: number }; category?: string } | null;
    const expected = (sig?.demand?.sales ?? 1) * months;
    const o = orders.get(r.id) ?? 0;
    add(byKeyword, r.keyword, o, expected);
    if (sig?.category) add(byCategory, sig.category, o, expected);
  }
  return { byKeyword, byCategory };
}

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
  let keywords: string[];
  if (opts.keywords) {
    // 직접 지정한 키워드(관리자 웹 '실행'): 연관 키워드로만 확장
    const seeds = [...new Set(opts.keywords.map((k) => k.trim()).filter(Boolean))];
    keywords = [...new Set([...seeds, ...(await expandKeywords(ctx, seeds))])];
  } else if (s.selection.keywordMode === 'auto') {
    // 자동: 키워드 풀(공급처 인기상품·카테고리 → 검색광고 검증)에서 고정 + 잘 팔린 + 점수 상위를 순환
    keywords = await pickKeywordsForRun(ctx, await winnerKeywords(ctx));
  } else {
    const seeds = [...new Set([...s.selection.seedKeywords, ...(await winnerKeywords(ctx))].map((k) => k.trim()).filter(Boolean))];
    keywords = [...new Set([...seeds, ...(await expandKeywords(ctx, seeds))])];
  }
  const result: SelectionResult = { runId, keywords: keywords.length, evaluated: 0, passed: 0, autoListed: 0, errors: [] };
  if (!keywords.length) return result;
  const signals = await collectSignals(ctx, keywords);
  // 이번 실행에서 어떤 키워드도 시장가를 못 받았으면 공급원이 없는 것으로 판단(전부 탈락 방지)
  const marketPriceAvailable = keywords.some((k) => signals[k] && marketReference(signals[k]!) !== null);
  const kwStats = new Map<string, { passed: number; listed: number }>(keywords.map((k) => [k, { passed: 0, listed: 0 }]));
  const seenTitles = new Set<string>();
  const sources = s.selection.sources.map((id) => ctx.sources.get(id)).filter((x): x is NonNullable<typeof x> => !!x && x.capabilities.search);

  const learned = await learnedHistory(ctx);
  const comp = Object.fromEntries((await ctx.db.selectFrom('keywords').select(['keyword', 'competition']).where('keyword', 'in', keywords).execute()).map((r) => [r.keyword, r.competition]));
  const model = { ...DEFAULT_MODEL, ...s.selection.model };
  const failCounts: Record<string, number> = {};

  for (const kw of keywords) {
    // 1) 공급처별 검색 → 키워드 공급가 중앙값(사람들이 많이 사는 가격대의 기준)
    const bySource: Array<{ src: (typeof sources)[number]; found: Awaited<ReturnType<(typeof sources)[number]['search']>> }> = [];
    for (const src of sources) {
      try {
        bySource.push({ src, found: await src.search(kw, { limit: s.selection.perKeywordLimit, minPrice: s.selection.minSupplyPrice, maxPrice: s.selection.maxSupplyPrice }) });
      } catch (e) {
        result.errors.push(`${src.id}/${kw}: ${errMessage(e)}`);
      }
    }
    const kwMedian = median(bySource.flatMap((x) => x.found.filter((i) => keywordMatches(i.title, kw)).map((i) => i.price)));
    for (const { src, found } of bySource) {
      for (const item of found) {
        try {
          const d = src.capabilities.detail ? await src.getProduct(item.sourceItemId, { title: item.title }) : null;
          if (!d) continue;
          const sp = await upsertSourceProduct(ctx, src.id, d);
          const already = await ctx.db.selectFrom('listings').select('id').where('source_product_id', '=', sp.id).where('status', 'not in', ['stopped', 'rejected']).executeTakeFirst();
          if (already) continue;
          const tp = targetPrice(s, { cost: d.price, shipping: d.shippingFee, categoryPath: d.categoryPath, inputVatDeductible: d.taxInvoice, minResalePrice: d.minResalePrice });
          const apiOrder = src.capabilities.apiOrder;
          const sig = { ...signals[kw] };
          // 같은 키워드 안에서 같은 상품명(다른 판매자 복제)은 한 번만. 키워드가 다르면 시장가 기준이 달라 따로 평가
          const dupKey = `${kw}|${d.title.replace(/\s+/g, '')}`;
          if (seenTitles.has(dupKey)) continue;
          seenTitles.add(dupKey);
          const gates = evaluateGates(s, d, tp, sig, { apiOrder, keyword: kw, enforceCategory: s.discovery.enforceCategoryForSources.includes(src.id), marketPriceAvailable });
          const passed = gates.every((g) => !g.hard || g.pass);
          for (const g of gates) if (g.hard && !g.pass) failCounts[g.name] = (failCounts[g.name] ?? 0) + 1;
          const quality = scoreCandidate(s, d, tp, sig, { apiOrder });
          // 2) 기대 월이익(수요 모델) — 우선순위의 핵심
          const conv = ['fastShipping', 'imageRichness', 'returnable'].map((k) => quality.parts[k]).filter((x): x is number => x !== undefined);
          const top = (d.categoryPath ?? '').split('>')[0] ?? '';
          const learnedKw = learnedFactor(learned.byKeyword.get(kw));
          const learnedCat = learnedFactor(learned.byCategory.get(top));
          const demand = expectedMonthly({
            searchVolume: sig.searchVolume,
            competition: comp[kw] ?? null,
            priceRatio: kwMedian ? d.price / kwMedian : undefined,
            slope: trendSlope(sig.trend, 4) ?? sig.volumeSlope,
            conversion: conv.length ? conv.reduce((a, b) => a + b, 0) / conv.length : undefined,
            brand: looksBranded(d.title),
            bulk: looksBulk(d.title),
            learned: Math.sqrt(learnedKw * learnedCat),
            unitProfit: tp.breakdown?.profit ?? 0,
          }, model);
          const blend = s.selection.demandBlend;
          const score = Math.round((profitScore(demand.profit) * blend + quality.score * (1 - blend)) * 1000) / 1000;
          const parts = { ...quality.parts, expectedProfit: profitScore(demand.profit) };
          result.evaluated++;
          if (passed) result.passed++;
          const ks = kwStats.get(kw) ?? { passed: 0, listed: 0 };
          if (passed) ks.passed++;
          kwStats.set(kw, ks);
          await ctx.db.insertInto('candidates').values({
            source_product_id: sp.id,
            keyword: kw,
            score,
            signals: JSON.stringify({ ...sig, trend: undefined, competition: comp[kw] ?? undefined, keywordMedianPrice: kwMedian, parts, demand, family: productFamily(d.title), category: top }),
            gates: JSON.stringify(gates),
            passed,
            target_price: tp.feasible ? tp.price : null,
            est_profit: tp.breakdown?.profit ?? null,
            est_margin: tp.breakdown?.margin ?? null,
            market_lowest: marketReference(sig)?.price ?? null,
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

  let auto: AutoListOutcome | null = null;
  if (s.selection.mode === 'auto' && !s.killSwitch) {
    auto = await autoList(ctx, runId);
    const listedKws = auto.listed.map((x) => x.keyword);
    result.autoListed = listedKws.length;
    for (const k of listedKws) {
      const ks = kwStats.get(k);
      if (ks) ks.listed++;
    }
  }
  await notifySelectionSummary(ctx, runId, result, auto);
  // 개선용 기록(1회 1행): 어떤 조건에서 몇 개가 왜 탈락·등록됐는지
  await ctx.db.insertInto('selection_runs').values({
    run_id: runId, at: ctx.clock.now(), keywords: result.keywords, evaluated: result.evaluated, passed: result.passed, listed: result.autoListed,
    fails: JSON.stringify(failCounts), skipped: JSON.stringify(auto?.skipped ?? {}), model: JSON.stringify({ ...model, blend: s.selection.demandBlend }),
  }).onConflict((oc) => oc.column('run_id').doNothing()).execute();
  await recordKeywordResults(ctx, kwStats);
  return result;
}

interface AutoListOutcome {
  listed: Array<{ keyword: string; title: string; price: number; profit: number | null; dryRun: boolean; monthly?: number }>;
  /** 등록하지 않은 이유별 개수 */
  skipped: Record<string, number>;
  stopReason?: string;
}

function demandOf(signals: unknown): { sales: number; profit: number } | undefined {
  const sig = (typeof signals === 'string' ? JSON.parse(signals) : signals) as { demand?: { sales: number; profit: number } } | null;
  return sig?.demand;
}

/** auto 모드: 무인 운영 조건을 만족하는 상위 후보만 자동 등록 */
async function autoList(ctx: AppContext, runId: string): Promise<AutoListOutcome> {
  const s = await ctx.settings.get();
  const out: AutoListOutcome = { listed: [], skipped: {} };
  const skip = (why: string) => (out.skipped[why] = (out.skipped[why] ?? 0) + 1);
  const rows = await ctx.db
    .selectFrom('candidates')
    .innerJoin('source_products', 'source_products.id', 'candidates.source_product_id')
    .select(['candidates.id', 'candidates.score', 'candidates.keyword', 'candidates.est_profit', 'candidates.signals', 'source_products.source', 'source_products.image_reuse_allowed', 'source_products.title'])
    .where('run_id', '=', runId)
    .where('passed', '=', true)
    .where('candidates.status', '=', 'new')
    .orderBy('score', 'desc')
    .execute();
  // 분산: 이미 운영 중인 상품의 계열·키워드 수(같은 상품 색상 변형 중복 등록, 한 키워드 몰빵 방지)
  const live = await ctx.db.selectFrom('listings').leftJoin('candidates', 'candidates.id', 'listings.candidate_id')
    .select(['listings.title', 'candidates.keyword']).where('listings.status', 'in', ['draft', 'pending_approval', 'active', 'paused']).execute();
  const families = new Set(live.map((x) => productFamily(x.title)));
  const perKeyword = new Map<string, number>();
  for (const x of live) if (x.keyword) perKeyword.set(x.keyword, (perKeyword.get(x.keyword) ?? 0) + 1);
  const seenProducts = new Set<string>();
  for (const r of rows) {
    if (out.listed.length >= s.selection.autoListPerRun) {
      skip(`1회 등록 한도(${s.selection.autoListPerRun}개) 초과`);
      continue;
    }
    if (r.score < s.selection.autoListMinScore) {
      skip(`점수 ${s.selection.autoListMinScore} 미만`);
      continue;
    }
    if (!r.image_reuse_allowed) {
      skip('공급처 이미지 재사용 불가');
      continue;
    }
    const src = ctx.sources.get(r.source);
    if (s.selection.autoListRequiresApiOrder && !src?.capabilities.apiOrder) {
      skip(`${src?.displayName ?? r.source}: 자동 발주 불가 공급처`);
      continue;
    }
    if (seenProducts.has(r.title)) continue;
    const fam = productFamily(r.title);
    if (fam && families.has(fam)) {
      skip('같은 상품(색상·사이즈 변형) 이미 등록');
      continue;
    }
    if ((perKeyword.get(r.keyword) ?? 0) >= s.selection.maxPerKeyword) {
      skip(`키워드당 ${s.selection.maxPerKeyword}개 한도`);
      continue;
    }
    seenProducts.add(r.title);
    try {
      const draft = await createDraftFromCandidate(ctx, r.id, 'auto');
      const l = await registerListing(ctx, draft.id, 'auto');
      out.listed.push({ keyword: r.keyword, title: r.title, price: l.sale_price, profit: r.est_profit, dryRun: !!l.dry_run, monthly: demandOf(r.signals)?.profit });
      if (fam) families.add(fam);
      perKeyword.set(r.keyword, (perKeyword.get(r.keyword) ?? 0) + 1);
    } catch (e) {
      const msg = errMessage(e);
      ctx.log.warn({ candidate: r.id, err: msg }, '자동 등록 실패');
      if (msg.includes('이미지 공개 주소 미설정')) {
        out.stopReason = msg;
        await ctx.notifications.notify('error', '자동 등록 중단: 이미지 공개 필요', msg, { path: '/settings', dedupeKey: 'autolist-media', dedupeMinutes: 24 * 60 });
        break;
      }
      if (msg.includes('쿠팡 정보 미입력')) {
        out.stopReason = msg;
        await ctx.notifications.notify('error', '자동 등록 중단: 설정 필요', `${msg}\n설정 화면에서 쿠팡 판매자 정보를 입력하면 다음 선정 주기에 자동 등록됩니다.`, { path: '/settings', dedupeKey: 'autolist-settings', dedupeMinutes: 24 * 60 });
        break;
      }
      if (msg.includes('상한')) {
        out.stopReason = msg;
        break;
      }
      skip(`등록 실패: ${msg.slice(0, 40)}`);
    }
  }
  return out;
}

/** 선정 1회 결과를 텔레그램으로: 무엇을 골랐고, 무엇을 등록했고, 왜 등록 안 했는지 */
async function notifySelectionSummary(ctx: AppContext, runId: string, result: SelectionResult, auto: AutoListOutcome | null): Promise<void> {
  const s = await ctx.settings.get();
  if (!result.evaluated && !result.errors.length) return;
  const won = (n: number | null | undefined) => (n === null || n === undefined ? '?' : `${Math.round(n).toLocaleString()}원`);
  const top = await ctx.db.selectFrom('candidates').innerJoin('source_products', 'source_products.id', 'candidates.source_product_id')
    .select(['source_products.title', 'source_products.source', 'candidates.score', 'candidates.est_profit', 'candidates.target_price', 'candidates.market_lowest', 'candidates.signals'])
    .where('run_id', '=', runId).where('passed', '=', true).orderBy('score', 'desc').limit(s.selection.topNotify).execute();
  const lines: string[] = [`키워드 ${result.keywords}개 · 검토 ${result.evaluated}개 · 통과 ${result.passed}개`];
  if (auto?.listed.length) {
    const dry = auto.listed.some((x) => x.dryRun);
    lines.push('', `✅ ${dry ? '모의 등록(실제 쿠팡엔 안 올라감)' : '쿠팡 등록 요청'} ${auto.listed.length}개`);
    for (const x of auto.listed) lines.push(`• ${x.title.slice(0, 30)} — ${won(x.price)} (개당 이익 ${won(x.profit)}${x.monthly !== undefined ? `, 기대 월이익 ${won(x.monthly)}` : ''})`);
  } else if (auto) {
    lines.push('', '등록한 상품 없음');
  }
  if (auto?.stopReason) lines.push(`⛔ 중단: ${auto.stopReason.slice(0, 120)}`);
  const skipped = Object.entries(auto?.skipped ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (skipped.length) lines.push(`등록 안 한 이유: ${skipped.map(([k, n]) => `${k} ${n}개`).join(' · ')}`);
  if (top.length) {
    lines.push('', '상위 후보');
    top.forEach((t, i) => {
      const dm = demandOf(t.signals);
      lines.push(`${i + 1}. ${t.title.slice(0, 30)} [${t.source}] 판매가 ${won(t.target_price)}~ · 개당 이익 ${won(t.est_profit)}${dm ? ` · 기대 월 ${dm.sales}개/${won(dm.profit)}` : ''}${t.market_lowest ? ` · 시장 최저 ${won(t.market_lowest)}` : ''}`);
    });
  }
  if (result.errors.length) lines.push('', `오류 ${result.errors.length}건(예: ${result.errors[0]!.slice(0, 80)})`);
  if (!auto) lines.push('', '수동 승인 모드: 관리 화면 [후보]에서 승인하면 등록됩니다.');
  await ctx.notifications.notify(auto?.listed.length ? 'info' : 'action', `상품 선정 결과${ctx.env.DRY_RUN ? ' (모의 실행)' : ''}`, lines.join('\n'), { path: '/candidates' });
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
