import type { Settings } from '../../config/settings.js';
import { roundUp } from '../../lib/util.js';

/**
 * 손익 모델 (docs/feasibility.md §2-1, docs/architecture.md §5)
 *
 *  S = 판매가(고객 결제, VAT 포함)    C = 공급가 합계(VAT 포함)    D = 공급처 배송비(VAT 포함)
 *  c = 판매수수료율(VAT 별도) → 실제 차감 c×(1+feeVat)
 *  r = 반품 충당률            F = 건당 고정비 배분(월 서비스이용료 / 예상 주문수)
 *  납부 VAT = S/11 − feeVat·c·S − (매입세액공제 가능 시 (C+D)/11)
 *
 *  P = S·(10/11 − c − r) − (C+D)·k − F     (k = 10/11 매입세액 공제 가능, 1 불가)
 *  (feeVat=0.1 일 때 성립: S − 1.1cS − rS − S/11 + 0.1cS = S(10/11 − c − r))
 */

export interface CostInput {
  /** 공급가 합계(수량 반영) */
  cost: number;
  /** 공급처 배송비 */
  shipping: number;
  /** 카테고리 경로(수수료 결정용) */
  categoryPath?: string | null;
  /** 매입 세금계산서 수취 가능 여부 */
  inputVatDeductible?: boolean;
  /** 정산에서 학습한 실제 수수료율(있으면 카테고리 표보다 우선) */
  feeRate?: number | null;
}

export interface ProfitBreakdown {
  salePrice: number;
  feeRate: number;
  fee: number;
  feeVat: number;
  returnReserve: number;
  vatPayable: number;
  fixedAllocation: number;
  profit: number;
  margin: number;
}

/** 카테고리 경로에 가장 길게 일치하는 수수료율 */
export function feeRateFor(settings: Settings, categoryPath?: string | null): number {
  if (!categoryPath) return settings.fees.defaultRate;
  const path = categoryPath.replace(/\s+/g, '');
  let best: { len: number; rate: number } | undefined;
  for (const r of settings.fees.categoryRates) {
    const m = r.match.replace(/\s+/g, '');
    if (m && path.includes(m) && (!best || m.length > best.len)) best = { len: m.length, rate: r.rate };
  }
  return best?.rate ?? settings.fees.defaultRate;
}

export function fixedAllocation(settings: Settings): number {
  return Math.round(settings.fees.monthlyServiceFee / Math.max(1, settings.fees.expectedMonthlyOrders));
}

export function computeProfit(settings: Settings, salePrice: number, input: CostInput): ProfitBreakdown {
  const c = input.feeRate ?? feeRateFor(settings, input.categoryPath);
  const fv = settings.fees.feeVatRate;
  const r = settings.pricing.returnReserveRate;
  const deductible = input.inputVatDeductible ?? settings.pricing.inputVatDeductibleDefault;
  const fee = salePrice * c;
  const feeVat = fee * fv;
  const returnReserve = salePrice * r;
  const inputVat = deductible ? (input.cost + input.shipping) / 11 : 0;
  const vatPayable = salePrice / 11 - feeVat - inputVat;
  const F = fixedAllocation(settings);
  const profit = salePrice - input.cost - input.shipping - fee - feeVat - returnReserve - vatPayable - F;
  return {
    salePrice,
    feeRate: c,
    fee: Math.round(fee),
    feeVat: Math.round(feeVat),
    returnReserve: Math.round(returnReserve),
    vatPayable: Math.round(vatPayable),
    fixedAllocation: F,
    profit: Math.round(profit),
    margin: salePrice > 0 ? profit / salePrice : 0,
  };
}

export interface TargetPrice {
  /** 최소 이익·이익률·준수가를 모두 만족하는 최저 판매가(=하한) */
  floor: number;
  /** 권장 판매가(현재는 floor와 같음 — 경쟁가 이하 노출 전제) */
  price: number;
  feasible: boolean;
  breakdown: ProfitBreakdown | null;
}

export function targetPrice(settings: Settings, input: CostInput & { minResalePrice?: number | null }): TargetPrice {
  const c = input.feeRate ?? feeRateFor(settings, input.categoryPath);
  const fv = settings.fees.feeVatRate;
  const r = settings.pricing.returnReserveRate;
  const deductible = input.inputVatDeductible ?? settings.pricing.inputVatDeductibleDefault;
  // 일반식: P = S·(1 − 1/11 − c(1+fv) + c·fv − r) − (C+D)·k − F
  const coef = 1 - 1 / 11 - c * (1 + fv) + c * fv - r;
  const k = deductible ? 10 / 11 : 1;
  const base = (input.cost + input.shipping) * k + fixedAllocation(settings);
  const m = settings.pricing.minMarginRate;
  if (coef <= 0 || coef - m <= 0) return { floor: Number.POSITIVE_INFINITY, price: Number.POSITIVE_INFINITY, feasible: false, breakdown: null };
  const byProfit = (settings.pricing.minProfitKrw + base) / coef;
  const byMargin = base / (coef - m);
  const unit = Math.max(10, settings.pricing.roundUnit);
  let floor = roundUp(Math.max(byProfit, byMargin), unit);
  if (input.minResalePrice && input.minResalePrice > floor) floor = roundUp(input.minResalePrice, unit);
  return { floor, price: floor, feasible: true, breakdown: computeProfit(settings, floor, input) };
}

/**
 * 가격 변경 가드: 하한 미만 금지, 1회 변동률 제한, 하루 횟수 제한.
 * 반환: 실제 적용할 가격(변경 불필요/불가 시 null)과 사유
 */
export function guardPriceChange(
  settings: Settings,
  opts: { current: number; desired: number; floor: number; changesToday: number },
): { price: number | null; reason: string } {
  const { current, floor, changesToday } = opts;
  let desired = Math.max(opts.desired, floor);
  if (desired === current) return { price: null, reason: 'no-change' };
  if (changesToday >= settings.pricing.maxPriceChangesPerDay) return { price: null, reason: 'daily-limit' };
  const maxUp = Math.floor(current * (1 + settings.pricing.maxChangeRatioUp));
  const maxDown = Math.ceil(current * (1 - settings.pricing.maxChangeRatioDown));
  if (desired > maxUp) desired = maxUp;
  if (desired < maxDown) desired = maxDown;
  // 비율 제한으로 하한을 못 맞추면(=인상 폭 부족) 적용은 하되 상위에서 판매중지 판단
  const unit = Math.max(10, settings.pricing.roundUnit);
  desired = desired > current ? roundUp(desired, unit) : Math.max(roundUp(desired, unit), roundUp(floor, unit));
  if (desired === current) return { price: null, reason: 'no-change' };
  return { price: desired, reason: desired > current ? 'raise' : 'lower' };
}

// ── 수익 극대화 ─────────────────────────────────────────────────

/** 끝자리 가격: 1만원 이상은 ○,900원, 미만은 ○○90원으로 올림(항상 원래 가격 이상) */
export function charmPrice(settings: Settings, price: number): number {
  if (settings.pricing.charmEnding === 'none') return roundUp(price, Math.max(10, settings.pricing.roundUnit));
  if (price >= 10000) return Math.ceil((price + 100) / 1000) * 1000 - 100;
  return Math.ceil((price + 10) / 100) * 100 - 10;
}

/** 판매가 = 끝자리(하한가 × (1 + 마크업)) */
export function priceFromMarkup(settings: Settings, floor: number, markup: number): number {
  const m = Math.max(0, Math.min(settings.pricing.maxMarkup, markup));
  return Math.max(floor, charmPrice(settings, floor * (1 + m)));
}

/**
 * 시작 마크업: 경쟁 최저가를 알면 그보다 undercutRate 낮은 가격이 되도록(하한 미만이면 0),
 * 모르면 defaultMarkup.
 */
export function initialMarkup(settings: Settings, floor: number, marketLowest?: number | null): number {
  if (!marketLowest || marketLowest <= 0) return settings.pricing.defaultMarkup;
  const m = (marketLowest * (1 - settings.pricing.undercutRate)) / floor - 1;
  return Math.max(0, Math.min(settings.pricing.maxMarkup, Math.round(m * 1000) / 1000));
}

/** 경쟁가 상한을 넘지 않는 최대 마크업 */
export function markupCapForMarket(settings: Settings, floor: number, marketLowest?: number | null): number {
  if (!marketLowest || marketLowest <= 0) return settings.pricing.maxMarkup;
  return Math.max(0, Math.min(settings.pricing.maxMarkup, (marketLowest * (1 - settings.pricing.undercutRate)) / floor - 1));
}

export interface BundleOption {
  units: number;
  floor: number;
}

/**
 * 묶음 수량 옵션별 하한가. 공급처가 여러 개를 배송비 1회로 보낼 수 있을 때만 2개 이상 옵션을 만든다.
 * shippingPerUnit=true(수량만큼 배송비 증가)면 묶음 이점이 없어 1개만.
 */
export function bundleOptions(
  settings: Settings,
  input: CostInput & { unitCost: number; shippingPerUnit?: boolean; maxPerBox?: number | null; stock?: number | null; minResalePrice?: number | null },
): BundleOption[] {
  const units = [...new Set([1, ...settings.pricing.bundleUnits])].sort((a, b) => a - b);
  const out: BundleOption[] = [];
  for (const n of units) {
    if (n > 1) {
      if (input.shippingPerUnit) continue;
      if (input.maxPerBox && n > input.maxPerBox) continue;
      if (input.stock !== null && input.stock !== undefined && input.stock < n * 5) continue;
    }
    const tp = targetPrice(settings, {
      ...input,
      cost: input.unitCost * n,
      shipping: input.shippingPerUnit ? input.shipping * n : input.shipping,
      minResalePrice: input.minResalePrice ? input.minResalePrice * n : null,
    });
    if (tp.feasible) out.push({ units: n, floor: tp.floor });
  }
  return out;
}
