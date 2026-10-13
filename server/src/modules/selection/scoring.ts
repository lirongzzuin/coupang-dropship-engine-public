import { keywordMatches } from './demandModel.js';
import { extractImageUrls } from '../listing/text.js';
import type { Settings } from '../../config/settings.js';
import type { SourceProductDetail } from '../../ports/source.js';
import type { TargetPrice } from '../pricing/pricing.js';

/** 순수 함수: 게이트·점수 계산(테스트 용이성을 위해 I/O 없음). 수식은 docs/selection-model.md */

export interface KeywordSignals {
  /** 월간 검색량(네이버 검색광고) */
  searchVolume?: number;
  /** 네이버 데이터랩 주간 추세(권한 있을 때만) */
  trend?: number[];
  /** 검색광고 검색량을 매일 저장해 만든 월별 추이의 기울기(-1~1) — 데이터랩 대체 */
  volumeSlope?: number;
  /** 구글 트렌드 주간 값(보조) */
  googleTrend?: number[];
  /** 오픈마켓(11번가 등) 최저가·상품 수·판매처 수 */
  marketLowest?: number;
  marketCount?: number;
  marketSellers?: number;
  marketSource?: string;
  /** 쿠팡 검색 상위 최저가·로켓 비율(쿠팡 파트너스) */
  coupangLowest?: number;
  coupangRocketRatio?: number;
  coupangSalesEst?: number;
  /** 상위 경쟁 상품 리뷰 수(쿠팡 리뷰 CSV) — 많을수록 신규 진입 어려움 */
  coupangReviews?: number;
}

/** 가격 경쟁 기준가: 쿠팡 판매이므로 쿠팡 최저가 우선, 없으면 오픈마켓(11번가) 최저가 */
export function marketReference(sig: KeywordSignals): { price: number; source: string } | null {
  if (sig.coupangLowest && sig.coupangLowest > 0) return { price: sig.coupangLowest, source: '쿠팡' };
  if (sig.marketLowest && sig.marketLowest > 0) return { price: sig.marketLowest, source: sig.marketSource ?? '오픈마켓' };
  return null;
}

export interface GateResult {
  name: string;
  pass: boolean;
  detail: string;
  /** soft=false 면 하드 게이트(탈락) */
  hard: boolean;
}

/** 월별 검색량 이력 → 최근 달 대비 이전 달 평균의 변화율(-1~1). 2개월 미만이면 undefined */
export function monthlySlope(history: Array<{ at: Date; value: number }>): number | undefined {
  const byMonth = new Map<string, number[]>();
  for (const h of history) {
    const m = h.at.toISOString().slice(0, 7);
    byMonth.set(m, [...(byMonth.get(m) ?? []), h.value]);
  }
  const months = [...byMonth.keys()].sort();
  if (months.length < 2) return undefined;
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const latest = avg(byMonth.get(months[months.length - 1]!)!);
  const prev = avg(months.slice(-4, -1).map((m) => avg(byMonth.get(m)!)));
  if (prev <= 0) return latest > 0 ? 1 : 0;
  return Math.max(-1, Math.min(1, (latest - prev) / prev));
}

export function trendSlope(series: number[] | undefined, window: number): number | undefined {
  if (!series || series.length < window * 2) return undefined;
  const recent = series.slice(-window);
  const prev = series.slice(-window * 2, -window);
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const p = avg(prev);
  if (p <= 0) return avg(recent) > 0 ? 1 : 0;
  return Math.max(-1, Math.min(1, (avg(recent) - p) / p));
}

export function evaluateGates(
  s: Settings,
  d: SourceProductDetail,
  tp: TargetPrice,
  sig: KeywordSignals,
  /** marketPriceAvailable=false: 시장가 공급원(11번가·파트너스)이 하나도 동작하지 않음 → 시장가 필수 조건을 적용하지 않음 */
  opts: { apiOrder: boolean; keyword?: string; enforceCategory?: boolean; marketPriceAvailable?: boolean },
): GateResult[] {
  const sel = s.selection;
  const text = `${d.title} ${d.categoryPath ?? ''}`;
  const g: GateResult[] = [];
  g.push({ name: 'status', hard: true, pass: d.status === 'active', detail: d.status });
  if (opts.keyword) {
    // 단어 단위 일치(복합명사는 끝 단어가 핵심): '필사노트'는 노트 ✓, '노트북'은 노트 ✗
    const rel = keywordMatches(d.title, opts.keyword);
    g.push({ name: 'relevance', hard: true, pass: rel, detail: rel ? '키워드 일치' : `상품명에 '${opts.keyword}' 없음` });
  }
  if (opts.enforceCategory && s.discovery.allowTopCategories.length) {
    const top = (d.categoryPath ?? '').split('>')[0] ?? '';
    const ok = !top || s.discovery.allowTopCategories.includes(top);
    g.push({ name: 'allowedCategory', hard: true, pass: ok, detail: ok ? top || '미상' : `허용 안 된 분류: ${top}` });
  }
  g.push({ name: 'moq', hard: true, pass: (d.minOrderQty ?? 1) <= 1, detail: `최소주문 ${d.minOrderQty ?? 1}개` });
  // 상품성: 출고가 늦으면 도착예정일이 늦어 전환·판매자점수에 불리
  if (d.prepDays !== undefined && Number.isFinite(d.prepDays)) g.push({ name: 'prepDays', hard: true, pass: d.prepDays <= sel.maxPrepDays, detail: `출고 준비 ${d.prepDays}일` });
  if (d.sellerScore !== undefined && Number.isFinite(d.sellerScore) && (d.sellerReviews ?? 0) >= 10) {
    g.push({ name: 'sellerQuality', hard: true, pass: d.sellerScore >= sel.minSellerScore, detail: `판매자 만족도 ${d.sellerScore}%` });
  }
  g.push({ name: 'stock', hard: true, pass: d.stock === null || d.stock >= sel.minStock, detail: `재고 ${d.stock ?? '미상'}` });
  g.push({ name: 'supplyPrice', hard: true, pass: d.price >= sel.minSupplyPrice && d.price <= sel.maxSupplyPrice, detail: `공급가 ${d.price}` });
  const blocked = sel.blockedKeywords.filter((k) => k && text.includes(k));
  g.push({ name: 'trademark', hard: true, pass: blocked.length === 0, detail: blocked.join(',') || 'ok' });
  const blockedCat = sel.blockedCategoryKeywords.filter((k) => k && text.includes(k));
  g.push({ name: 'category', hard: true, pass: blockedCat.length === 0, detail: blockedCat.join(',') || 'ok' });
  const kcNeeded = sel.kcSensitiveKeywords.some((k) => k && text.includes(k));
  const kcOk = !kcNeeded || !!(d.kc && (d.kc.certified || d.kc.exempt));
  g.push({ name: 'kc', hard: true, pass: kcOk, detail: kcNeeded ? (kcOk ? 'KC 정보 있음' : 'KC 인증정보 없음') : '해당 없음' });
  g.push({ name: 'profit', hard: true, pass: tp.feasible && (tp.breakdown?.profit ?? -1) >= s.pricing.minProfitKrw, detail: tp.feasible ? `목표가 ${tp.price} 이익 ${tp.breakdown?.profit}` : '불가' });
  const ref = marketReference(sig);
  if (ref) {
    const limit = ref.price * (1 + sel.competitiveTolerance);
    g.push({ name: 'competitive', hard: true, pass: tp.price <= limit, detail: `목표가 ${tp.price} / ${ref.source} 최저 ${ref.price}` });
  } else {
    const required = sel.requireMarketPrice && opts.marketPriceAvailable !== false;
    g.push({ name: 'competitive', hard: required, pass: !required, detail: opts.marketPriceAvailable === false ? '시장가 공급원 없음(11번가·쿠팡 파트너스 키 미설정) — 가격 최적화가 판매 결과로 조정' : '시장가 정보 없음' });
  }
  g.push({ name: 'images', hard: false, pass: d.imageReuseAllowed, detail: d.imageReuseAllowed ? '공급처 이미지 사용 가능' : '직접 이미지 필요' });
  g.push({ name: 'notice', hard: false, pass: !!d.notice?.items?.length, detail: d.notice?.items?.length ? '고시정보 있음' : '고시정보 없음(상세페이지 참조로 채움)' });
  g.push({ name: 'apiOrder', hard: false, pass: opts.apiOrder, detail: opts.apiOrder ? '자동 발주 가능' : '구매 대행 작업 필요' });
  return g;
}

export function scoreCandidate(
  s: Settings,
  d: SourceProductDetail,
  tp: TargetPrice,
  sig: KeywordSignals,
  opts: { apiOrder: boolean },
): { score: number; parts: Record<string, number> } {
  const w = s.selection.weights;
  const parts: Record<string, number> = {};
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  if (sig.searchVolume !== undefined) parts.demand = clamp(Math.log10(sig.searchVolume + 1) / 5);
  // 추세: 데이터랩 → 없으면 검색량 월별 추이
  const slope = trendSlope(sig.trend, 4) ?? sig.volumeSlope;
  if (slope !== undefined) parts.trend = (slope + 1) / 2;
  const gSlope = trendSlope(sig.googleTrend, 4);
  if (gSlope !== undefined) parts.googleTrend = (gSlope + 1) / 2;
  if (sig.marketCount !== undefined) parts.competition = 1 - clamp(Math.log10(sig.marketCount + 1) / 6);
  const ref = marketReference(sig);
  if (ref && tp.feasible) parts.priceAdvantage = clamp(((ref.price - tp.price) / ref.price) * 5);
  if (sig.coupangRocketRatio !== undefined) parts.rocketCompetition = 1 - clamp(sig.coupangRocketRatio);
  if (tp.feasible && tp.breakdown) parts.margin = clamp(tp.breakdown.margin / 0.3);
  // 이익 잠재력: 개당 이익(원) × 수요(월 검색량). 이익 5천원·검색 1만이면 약 0.77
  if (tp.feasible && tp.breakdown && sig.searchVolume !== undefined) {
    parts.profitPotential = clamp(Math.log10(Math.max(1, tp.breakdown.profit) * Math.max(1, sig.searchVolume) / 1000) / 6);
  }
  parts.supplier = clamp((d.sellerScore !== undefined ? d.sellerScore / 100 : 0.7) * 0.7 + (opts.apiOrder ? 0.3 : 0));
  if (sig.coupangSalesEst !== undefined) parts.coupangSales = clamp(Math.log10(sig.coupangSalesEst + 1) / 4);
  // 상품성(살 만한 상품인가)
  if (d.prepDays !== undefined) parts.fastShipping = d.prepDays <= 1 ? 1 : d.prepDays === 2 ? 0.6 : d.prepDays === 3 ? 0.3 : 0;
  // 대표·추가 이미지 + 상세 이미지(공급처 상세 HTML) — 상세가 풍부할수록 구매 전환 유리
  parts.imageRichness = clamp(((d.images?.length ?? 0) + (d.detailHtml ? extractImageUrls(d.detailHtml).length : 0)) / 6);
  if (d.returnable !== undefined) parts.returnable = d.returnable ? 1 : 0;
  if (sig.coupangReviews !== undefined) parts.entryBarrier = 1 - clamp(Math.log10(sig.coupangReviews + 1) / 4);
  // 계산 불가(NaN·무한대) 신호는 제외 — 외부 데이터 이상이 점수 전체를 망치지 않도록
  for (const k of Object.keys(parts)) if (!Number.isFinite(parts[k]!)) delete parts[k];
  let num = 0, den = 0;
  for (const [k, v] of Object.entries(parts)) {
    const wk = (w as Record<string, number>)[k] ?? 0;
    num += wk * v;
    den += wk;
  }
  return { score: den > 0 ? Math.round((num / den) * 1000) / 1000 : 0, parts };
}
