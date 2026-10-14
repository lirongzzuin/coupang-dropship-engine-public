import type {
  SourceAdapter, SourceOrderCheck, SourceOrderCheckRequest, SourceOrderRequest, SourceOrderResult, SourceOrderState, SourceProductDetail, SourceProductSummary, SourceTracking,
} from '../../ports/source.js';
import { pickDefaultOption } from '../options.js';

/** 테스트·데모용 공급처. apiOrder 여부를 생성자에서 정해 두 가지 흐름(API/작업함)을 모두 검증한다. */
export class MockSource implements SourceAdapter {
  readonly displayName: string;
  readonly capabilities: { search: boolean; detail: boolean; apiOrder: boolean; apiTracking: boolean };
  products = new Map<string, SourceProductDetail>();
  orders = new Map<string, { req: SourceOrderRequest; tracking?: SourceTracking }>();
  failNext = new Map<string, number>();
  needsPayment = false;
  categories: Array<{ code: string; name: string; path: string; leaf: boolean }> = [];
  popular = new Map<string, SourceProductSummary[]>();
  private seq = 0;

  constructor(readonly id = 'mock', opts: { apiOrder?: boolean } = {}) {
    this.displayName = `Mock(${id})`;
    const api = opts.apiOrder ?? true;
    this.capabilities = { search: true, detail: true, apiOrder: api, apiTracking: api };
  }

  private maybeFail(name: string): void {
    const n = this.failNext.get(name) ?? 0;
    if (n > 0) {
      this.failNext.set(name, n - 1);
      throw new Error(`mock ${name} failure`);
    }
  }

  add(p: Partial<SourceProductDetail> & { sourceItemId: string; title: string; price: number }): SourceProductDetail {
    const full: SourceProductDetail = {
      url: `https://mock.example/${p.sourceItemId}`,
      imageUrl: `https://mock.example/${p.sourceItemId}.jpg`,
      shippingFee: 3000,
      status: 'active',
      stock: 100,
      imageReuseAllowed: true,
      images: [`https://mock.example/${p.sourceItemId}.jpg`],
      taxInvoice: true,
      prepDays: 1,
      categoryPath: '생활용품>수납/정리',
      notice: { type: '기타 재화', items: [{ name: '품명 및 모델명', value: p.title }, { name: '제조국(원산지)', value: '대한민국' }] },
      kc: { certified: false, exempt: false },
      ...p,
    };
    this.products.set(full.sourceItemId, full);
    return full;
  }

  async search(keyword: string, opts: { limit?: number; minPrice?: number; maxPrice?: number } = {}): Promise<SourceProductSummary[]> {
    this.maybeFail('search');
    return [...this.products.values()]
      .filter((p) => keyword.split(/\s+/).filter(Boolean).every((w) => p.title.includes(w)) && p.status === 'active')
      .filter((p) => (!opts.minPrice || p.price >= opts.minPrice) && (!opts.maxPrice || p.price <= opts.maxPrice))
      .slice(0, opts.limit ?? 20)
      .map(({ sourceItemId, title, url, imageUrl, price, shippingFee }) => ({ sourceItemId, title, url, imageUrl, price, shippingFee }));
  }

  async listCategories() {
    return this.categories;
  }

  async popularItems(code: string, limit: number): Promise<SourceProductSummary[]> {
    return (this.popular.get(code) ?? []).slice(0, limit);
  }

  /** 테스트: 상품별 getProduct 실패 횟수(특정 상품만 조회 실패) */
  failProduct = new Map<string, number>();

  async getProduct(id: string, hint: { option?: string } = {}): Promise<SourceProductDetail | null> {
    this.maybeFail('getProduct');
    const n = this.failProduct.get(id) ?? 0;
    if (n > 0) {
      this.failProduct.set(id, n - 1);
      throw new Error(`mock getProduct ${id} failure`);
    }
    const p = this.products.get(id);
    if (!p) return null;
    const d = structuredClone(p);
    // 옵션 고정: 실제 어댑터처럼 그 옵션의 가격·재고로, 없으면 판매 불가
    if (hint.option && d.options?.length) {
      const o = d.options.find((x) => x.name === hint.option);
      if (!o) return { ...d, status: 'ended', stock: 0, defaultOption: hint.option, unavailableReason: `판매 옵션(${hint.option})이 공급처에서 없어짐` };
      return { ...d, price: o.price, stock: o.stock, defaultOption: o.name, status: d.status === 'active' && o.stock === 0 ? 'soldout' : d.status };
    }
    // 실제 어댑터처럼 옵션이 여러 개면 기본 옵션(가장 싼 재고 옵션)을 정해 그 가격·재고로
    const named = (d.options ?? []).filter((o) => o.name);
    if (!hint.option && !d.defaultOption && named.length > 1) {
      const def = pickDefaultOption(named)!;
      return { ...d, price: def.price, stock: def.stock, defaultOption: def.name };
    }
    return d;
  }

  /** 테스트: 주문 가능 점검 응답(상품별). 없으면 상품 상태로 판단 */
  orderCheck = new Map<string, SourceOrderCheck>();
  orderChecks: SourceOrderCheckRequest[] = [];

  async checkOrderable(req: SourceOrderCheckRequest): Promise<SourceOrderCheck> {
    this.orderChecks.push(req);
    const preset = this.orderCheck.get(req.sourceItemId);
    if (preset) return preset;
    const p = this.products.get(req.sourceItemId);
    if (!p || p.status !== 'active') return { ok: false, definitive: true, reason: '주문할 수 없는 상품입니다' };
    const price = (req.option && p.options?.find((o) => o.name === req.option)?.price) || p.price;
    return { ok: true, cost: price * req.qty, shippingCost: p.shippingFee };
  }

  async placeOrder(req: SourceOrderRequest): Promise<SourceOrderResult> {
    this.maybeFail('placeOrder');
    for (const [id, o] of this.orders) if (o.req.idempotencyKey === req.idempotencyKey) {
      const p = this.products.get(req.sourceItemId)!;
      return { sourceOrderId: id, cost: p.price * req.qty, shippingCost: p.shippingFee, needsPayment: this.needsPayment };
    }
    const p = this.products.get(req.sourceItemId);
    if (!p || p.status !== 'active') throw new Error('품절');
    const id = `MO${++this.seq}`;
    this.orders.set(id, { req });
    if (this.needsPayment) this.orderStates.set(id, 'unpaid');
    return { sourceOrderId: id, cost: p.price * req.qty, shippingCost: p.shippingFee, needsPayment: this.needsPayment };
  }

  /** 테스트: 공급처가 송장을 등록 */
  ship(sourceOrderId: string, trackingNo = '123456789012', courierName = 'CJ대한통운'): void {
    const o = this.orders.get(sourceOrderId);
    if (!o) throw new Error('no order');
    o.tracking = { courierName, trackingNo };
  }

  async getTracking(sourceOrderId: string): Promise<SourceTracking | null> {
    return this.orders.get(sourceOrderId)?.tracking ?? null;
  }

  /** 테스트: 공급처 주문 상태(기본 ok, needsPayment 로 만든 주문은 unpaid) */
  orderStates = new Map<string, SourceOrderState>();
  cancelled: string[] = [];

  async getOrderInfo(sourceOrderId: string) {
    const o = this.orders.get(sourceOrderId);
    const state = this.orderStates.get(sourceOrderId) ?? (o ? 'ok' : 'other');
    return { state, rawStatus: state, tracking: o?.tracking ?? null };
  }

  /** 테스트: 공급처 취소 방식 — instant(결제완료라 즉시 취소) | request(준비중이라 취소 요청 → 공급사 수락 대기) | fail */
  cancelMode: 'instant' | 'request' | 'fail' = 'instant';

  async cancelOrder(sourceOrderId: string, _reason: string) {
    if (this.cancelMode === 'fail') return { ok: false, status: '', message: '취소 불가 상태' };
    this.cancelled.push(sourceOrderId);
    const state = this.cancelMode === 'instant' ? 'cancelled' : 'cancel_requested';
    this.orderStates.set(sourceOrderId, state);
    return { ok: true, status: state, message: 'ok' };
  }
}
