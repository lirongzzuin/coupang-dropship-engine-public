import type { Settings } from '../../config/settings.js';
import type { SourceProductDetail } from '../../ports/source.js';
import type { TargetPrice } from '../pricing/pricing.js';

/** 순수 함수: 게이트·점수 계산(테스트 용이성을 위해 I/O 없음). 수식은 docs/selection-model.md */

export interface KeywordSignals {
  searchVolume?: number;
  trend?: number[];
  naverLowest?: number;
  naverCount?: number;
  naverMalls?: number;
  coupangSalesEst?: number;
}

export interface GateResult {
  name: string;
  pass: boolean;
  detail: string;
  /** soft=false 면 하드 게이트(탈락) */
  hard: boolean;
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
  opts: { apiOrder: boolean },
): GateResult[] {
  const sel = s.selection;
  const text = `${d.title} ${d.categoryPath ?? ''}`;
  const g: GateResult[] = [];
  g.push({ name: 'status', hard: true, pass: d.status === 'active', detail: d.status });
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
  if (sig.naverLowest && sig.naverLowest > 0) {
    const limit = sig.naverLowest * (1 + sel.competitiveTolerance);
    g.push({ name: 'competitive', hard: true, pass: tp.price <= limit, detail: `목표가 ${tp.price} / 시장최저 ${sig.naverLowest}` });
  } else {
    g.push({ name: 'competitive', hard: sel.requireMarketPrice, pass: !sel.requireMarketPrice, detail: '시장가 정보 없음' });
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
  const slope = trendSlope(sig.trend, 4);
  if (slope !== undefined) parts.trend = (slope + 1) / 2;
  if (sig.naverCount !== undefined) parts.competition = 1 - clamp(Math.log10(sig.naverCount + 1) / 6);
  if (sig.naverLowest && tp.feasible) parts.priceAdvantage = clamp(((sig.naverLowest - tp.price) / sig.naverLowest) * 5);
  if (tp.feasible && tp.breakdown) parts.margin = clamp(tp.breakdown.margin / 0.3);
  parts.supplier = clamp((d.sellerScore !== undefined ? d.sellerScore / 100 : 0.7) * 0.7 + (opts.apiOrder ? 0.3 : 0));
  if (sig.coupangSalesEst !== undefined) parts.coupangSales = clamp(Math.log10(sig.coupangSalesEst + 1) / 4);
  let num = 0, den = 0;
  for (const [k, v] of Object.entries(parts)) {
    const wk = (w as Record<string, number>)[k] ?? 0;
    num += wk * v;
    den += wk;
  }
  return { score: den > 0 ? Math.round((num / den) * 1000) / 1000 : 0, parts };
}
