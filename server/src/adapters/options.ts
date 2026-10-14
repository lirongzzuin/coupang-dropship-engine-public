import type { SourceOption } from '../ports/source.js';

/** 공급처 옵션 공통 처리(오너클랜·도매꾹) */

/** 옵션 이름 비교(공백·구분자 앞뒤 공백 차이 무시) */
export function sameOption(a: string, b: string): boolean {
  const n = (x: string) => x.replace(/\s+/g, '').toLowerCase();
  return n(a) === n(b);
}

/** 재고 있는 옵션 중 가장 싼 것, 같으면 재고 많은 것 */
export function pickDefaultOption<T extends { name: string; price: number; stock: number | null }>(opts: T[]): T | undefined {
  const inStock = opts.filter((o) => o.name && (o.stock === null || o.stock > 0));
  return [...(inStock.length ? inStock : opts)].sort((a, b) => a.price - b.price || (b.stock ?? 0) - (a.stock ?? 0))[0];
}

/**
 * 판매·발주할 옵션 결정. 이미 쿠팡에 올린 옵션(pin)이 있으면 그 옵션만(없어졌으면 pinMissing),
 * 없으면 minChoices 개 이상일 때 기본 옵션을 고른다.
 */
export function resolveOption(opts: SourceOption[], pin: string | undefined, minChoices: number): { chosen?: SourceOption; pinMissing: boolean } {
  if (pin) {
    const chosen = opts.find((o) => sameOption(o.name, pin));
    return { chosen, pinMissing: !chosen };
  }
  const named = opts.filter((o) => o.name);
  return { chosen: named.length >= minChoices ? pickDefaultOption(named) : undefined, pinMissing: false };
}
