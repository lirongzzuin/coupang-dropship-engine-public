import type { SourceProductDetail } from '../ports/source.js';

/**
 * 공급처 최소 구매수량·구매 단위 규칙(오너클랜·도매꾹 공통).
 * 쿠팡에서는 1개(묶음 옵션이면 2·3개)씩 팔리고 주문마다 고객 주소로 그 수량만 발주하므로,
 * 공급처가 그 수량을 받아주지 않으면(최소 N개 이상, N개 단위) 팔 수 없다.
 * - 오너클랜: API에 최소 구매수량이 없음(위탁 서비스, 1개 발주) → 1
 * - 도매매(배송대행): 구매 단위 supplyUnit(실측 120개 모두 1)
 * - 도매꾹(도매): 최소 구매수량 domeMoq, 구매 단위 domeUnit(예: 100개 단위)
 */
export function orderQtyRule(d: Pick<SourceProductDetail, 'minOrderQty' | 'orderUnit'> | null | undefined): { min: number; unit: number } {
  const n = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) >= 1 ? Math.floor(Number(v)) : 1);
  return { min: n(d?.minOrderQty), unit: n(d?.orderUnit) };
}

/** 사람이 읽을 규칙(예: "최소 2개", "100개 단위", "최소 2개·10개 단위") */
export function describeOrderQty(d: Pick<SourceProductDetail, 'minOrderQty' | 'orderUnit'> | null | undefined): string {
  const { min, unit } = orderQtyRule(d);
  return [min > 1 ? `최소 ${min}개` : '', unit > 1 ? `${unit}개 단위` : ''].filter(Boolean).join('·') || '1개';
}

/** 이 수량을 공급처에서 살 수 있는지 */
export function canOrderQty(d: Pick<SourceProductDetail, 'minOrderQty' | 'orderUnit'> | null | undefined, qty: number): boolean {
  const { min, unit } = orderQtyRule(d);
  return qty >= min && qty % unit === 0;
}

/** 1개 단위로 팔 수 없는 상품이면 사유(등록·판매 불가), 아니면 null */
export function orderQtyIssue(d: Pick<SourceProductDetail, 'minOrderQty' | 'orderUnit'> | null | undefined): string | null {
  const { min, unit } = orderQtyRule(d);
  if (min > 1 && unit > 1 && unit !== min) return `공급처 최소 구매수량 ${min}개·${unit}개 단위 — 1개씩 발주 불가`;
  if (min > 1) return `공급처 최소 구매수량 ${min}개 — 1개씩 발주 불가`;
  if (unit > 1) return `공급처 구매 단위 ${unit}개 — 1개씩 발주 불가`;
  return null;
}
