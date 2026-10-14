/**
 * 수요 모델: "이 상품을 올리면 한 달에 얼마를 벌까?"(기대 월이익)를 데이터로 추정해 우선순위를 매긴다.
 *
 *   기대 월판매 = 기본판매율 × (월검색량/1만)^0.6 × 가격대 × 경쟁 × 구매전환 × 브랜드·대량 보정 × 추세 × 학습계수
 *   기대 월이익 = 기대 월판매 × 개당 이익
 *
 * - 가격대: 같은 키워드로 검색된 공급 상품들의 중앙가 대비 위치. 중앙가 근처가 사람들이 많이 사는 가격대
 *   (시장가 API가 없어도 공급처 검색 결과만으로 계산)
 * - 학습계수: 우리 상품의 실제 판매 기록(같은 키워드·카테고리). 데이터가 쌓일수록 추정이 실제에 가까워짐
 * 모든 함수는 I/O 없는 순수 함수(테스트·튜닝 용이). 계수는 settings.selection.model 에서 조정.
 */

export interface DemandInput {
  searchVolume?: number;
  /** 네이버 검색광고 경쟁정도 */
  competition?: string | null;
  /** 이 상품 공급가 / 키워드 공급가 중앙값 */
  priceRatio?: number;
  /** 판매가 / 시장 최저가(쿠팡·11번가, 알 때만) */
  marketRatio?: number;
  /** 같은 상품(계열)을 더 싸게 파는 공급처가 있음 → 경쟁 판매자가 더 싸게 팔 수 있음 */
  undercutBySameProduct?: boolean;
  /** 월별 검색량 추이 기울기(-1~1) */
  slope?: number;
  /** 0~1: 빠른 출고·이미지·반품 등 구매 전환 요인 평균 */
  conversion?: number;
  brand?: boolean;
  bulk?: boolean;
  /** 우리 판매 기록 기반 보정(1=중립) */
  learned?: number;
  /** 개당 예상 이익(원) */
  unitProfit: number;
  /** 소비자 판매가(원) — 가격이 낮을수록 가볍게 구매(충동구매·비교 부담↓) */
  salePrice?: number;
}

export interface DemandModelParams {
  /** 검색량 1만 키워드에서 신규 상품 하나가 한 달에 팔릴 것으로 보는 개수(사전값, 학습으로 보정) */
  baseSalesPer10k: number;
  volumeExponent: number;
  brandFactor: number;
  bulkFactor: number;
  /** 가격 매력의 기준가(이 가격에서 1.0) */
  refPrice: number;
  /** 가격 탄력: 클수록 비싼 상품의 구매 확률이 빠르게 감소 */
  priceElasticity: number;
}

export const DEFAULT_MODEL: DemandModelParams = { baseSalesPer10k: 1.5, volumeExponent: 0.6, brandFactor: 0.6, bulkFactor: 0.5, refPrice: 15000, priceElasticity: 0.8 };

/** 가격 매력: (기준가/판매가)^탄력. 9,900원≈1.4, 15,000원=1, 30,000원≈0.57, 89,000원≈0.24 */
export function priceAppealFactor(salePrice: number | undefined, p: Pick<DemandModelParams, 'refPrice' | 'priceElasticity'> = DEFAULT_MODEL): number {
  if (!salePrice || salePrice <= 0) return 1;
  return clamp(Math.pow(p.refPrice / salePrice, p.priceElasticity), 0.1, 1.8);
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/**
 * 가격 경쟁력(쿠팡 이용자는 "필요한 걸 빠르고 싸게") — 비슷한 상품보다 쌀수록 ↑, 비쌀수록 ↓
 * - 키워드 중앙가 대비: 30% 싸면 1.09, 같으면 1, 2배면 0.5, 2.5배 넘으면 추가 절반
 * - 시장 최저가(알 때) 대비 판매가: 최저가 이하 1.3, +10%까지 1.0, 그 이상 급감(+30%≈0.55)
 * - 같은 상품을 더 싸게 들여오는 공급처가 있으면 0.7
 */
export function priceCompetitiveness(ratio?: number, marketRatio?: number, undercut?: boolean): number {
  let f = 0.9;
  if (ratio && Number.isFinite(ratio) && ratio > 0) {
    f = ratio <= 1 ? 1 + 0.3 * (1 - ratio) : 1 / ratio;
    if (ratio > 2.5) f *= 0.5;
  }
  if (marketRatio && Number.isFinite(marketRatio) && marketRatio > 0) {
    f *= marketRatio <= 1 ? 1.3 : marketRatio <= 1.1 ? 1 : Math.exp(-3 * (marketRatio - 1.1));
  }
  if (undercut) f *= 0.7;
  return clamp(f, 0.05, 1.6);
}

/** @deprecated 호환용 — priceCompetitiveness 사용 */
export function priceBandFactor(ratio?: number): number {
  return Math.min(1, priceCompetitiveness(ratio));
}

export function competitionFactor(c?: string | null): number {
  return c === '낮음' ? 1.2 : c === '중간' ? 1 : c === '높음' ? 0.6 : 0.9;
}

export function expectedMonthly(input: DemandInput, p: DemandModelParams = DEFAULT_MODEL): { sales: number; profit: number; factors: Record<string, number> } {
  const factors: Record<string, number> = {
    // 검색량을 못 받았으면(외부 API 장애) 0이 아니라 중립값 — 장애가 선정 전체를 멈추지 않게
    volume: input.searchVolume === undefined ? 0.5 : Math.pow(Math.max(0, input.searchVolume) / 10000, p.volumeExponent),
    priceCompetitiveness: priceCompetitiveness(input.priceRatio, input.marketRatio, input.undercutBySameProduct),
    priceAppeal: priceAppealFactor(input.salePrice, p),
    competition: competitionFactor(input.competition),
    conversion: 0.6 + 0.4 * clamp(input.conversion ?? 0.5, 0, 1),
    brand: input.brand ? p.brandFactor : 1,
    bulk: input.bulk ? p.bulkFactor : 1,
    trend: 1 + 0.5 * clamp(input.slope ?? 0, -1, 1),
    learned: clamp(input.learned ?? 1, 0.2, 4),
  };
  const sales = p.baseSalesPer10k * Object.values(factors).reduce((a, b) => a * b, 1);
  return { sales: Math.round(sales * 100) / 100, profit: Math.round(sales * Math.max(0, input.unitProfit)), factors };
}

/** 기대 월판매(개) → 0~1 점수. 월 1개≈0.5, 3개≈0.75, 10개≈1 */
export function salesScore(monthlySales: number): number {
  return clamp(Math.log10(Math.max(0, monthlySales) * 10 + 1) / 2, 0, 1);
}

/** 최종 우선순위: 기대 월이익 + 기대 월판매(잘 팔리는 상품 가점) + 품질 */
export function rankScore(demand: { sales: number; profit: number }, quality: number, w: { profit: number; sales: number; quality: number }): number {
  const sum = w.profit + w.sales + w.quality || 1;
  return Math.round(((profitScore(demand.profit) * w.profit + salesScore(demand.sales) * w.sales + quality * w.quality) / sum) * 1000) / 1000;
}

/** 기대 월이익(원) → 0~1 점수. 월 1만원≈0.4, 5만원≈0.55, 30만원≈0.7 */
export function profitScore(monthlyProfit: number): number {
  return clamp(Math.log10(Math.max(0, monthlyProfit) + 1) / 7.5, 0, 1);
}

// ── 상품명 분석 ───────────────────────────────────────────

const SUFFIX_OK = ['세트', 'set', '용', '형', '류', '대형', '중형', '소형', '미니', '케이스'];

function tokens(title: string): string[] {
  return title
    .replace(/[\[\(【{][^\]\)】}]*[\]\)】}]/g, ' ')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * 상품명이 키워드의 상품인지(한국어 복합명사는 끝 단어가 핵심):
 *   "필사노트"는 '노트'의 일종 ✓, "노트북"은 '노트'가 아님 ✗, "캠핑의자세트" ✓
 * 여러 단어 키워드는 모든 단어가 각각 일치하거나, 붙여 쓴 형태가 일치하면 통과.
 */
export function keywordMatches(title: string, keyword: string): boolean {
  const toks = tokens(title);
  const one = (kw: string) =>
    toks.some((t) => t === kw || t.endsWith(kw) || (t.startsWith(kw) && SUFFIX_OK.includes(t.slice(kw.length))));
  const kw = keyword.toLowerCase().replace(/\s+/g, '');
  if (one(kw)) return true;
  const words = keyword.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length > 1 && words.every(one);
}

/** 같은 상품의 색상·사이즈·모델 변형을 하나로 묶는 키 */
const COLOR = /(블랙|화이트|그레이|베이지|네이비|핑크|블루|레드|그린|브라운|아이보리|옐로우|퍼플|민트|오렌지|실버|골드|투명|검정|흰색|회색|적색|청색|녹색|황색|빨강|파랑|노랑|초록)/g;
export function productFamily(title: string): string {
  return tokens(title)
    .map((t) => t.replace(COLOR, ''))
    .filter((t) => t.length >= 2 && !/\d/.test(t) && !/^[a-z]{1,5}$/.test(t))
    .slice(0, 6)
    .join(' ');
}

/** "3M)포스트잇", "브레인)수납정리함" 같은 브랜드 표기(오너클랜 관행) 또는 [브랜드] */
export function looksBranded(title: string): boolean {
  return /^\s*[^\s)]{1,12}\)/.test(title) || /^\s*\[[^\]]{1,12}\]/.test(title);
}

/** 업소용·대량 묶음(10EA, 20개입, 대용량팩) — 개인 소비자 수요가 적음 */
export function looksBulk(title: string): boolean {
  if (/(대용량팩|업소용|벌크|박스단위|도매용)/.test(title)) return true;
  const m = [...title.matchAll(/(\d+)\s*(ea|개입|개|팩|박스|box|세트|set|롤)\b/gi)];
  return m.some((x) => Number(x[1]) >= 10);
}

/** 학습계수: 같은 키워드(또는 카테고리)로 올린 우리 상품들의 실제 판매 vs 기대 판매. 베이즈 평활(데이터 적으면 1 근처) */
export function learnedFactor(history: { orders: number; expected: number } | undefined, prior = 2): number {
  if (!history) return 1;
  return clamp((history.orders + prior) / (history.expected + prior), 0.2, 4);
}

export function median(xs: number[]): number | undefined {
  const v = xs.filter((x) => x > 0 && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return undefined;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1]! + v[m]!) / 2;
}
