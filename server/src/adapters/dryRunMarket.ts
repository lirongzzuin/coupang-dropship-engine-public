import type { Env, LiveFeature } from '../config/env.js';
import { isLive } from '../config/env.js';
import type { Logger } from '../lib/logger.js';
import type { InvoiceInput, MarketPort, MarketResult } from '../ports/market.js';
import { FakeMarket } from './fake/fakeMarket.js';

/**
 * 모든 외부 부작용을 기능 플래그로 감싼다. 조회는 그대로 통과.
 * DRY_RUN=true(기본)이면 부작용 메서드는 실제 호출 없이 성공을 흉내 내고 로그만 남긴다.
 */
export class DryRunMarket implements MarketPort {
  readonly name: string;
  private seq = 0;
  constructor(
    private readonly inner: MarketPort,
    private readonly env: Env,
    private readonly log: Logger,
  ) {
    this.name = inner.name;
  }

  /** 실제 판매채널(등록 사전 점검처럼 사람이 명시적으로 요청한 경우에만 사용) */
  raw(): MarketPort {
    return this.inner;
  }

  /** 체험 모드에서 내부 가짜 쿠팡 접근 */
  innerFake(): FakeMarket | undefined {
    return this.inner instanceof FakeMarket ? this.inner : undefined;
  }

  private live(f: LiveFeature): boolean {
    return isLive(this.env, f);
  }

  private simulated(action: string, detail: unknown): MarketResult {
    this.log.info({ action, detail }, '[DRY_RUN] 외부 호출 생략');
    return { ok: true, retryable: false, message: `DRY_RUN: ${action}`, dryRun: true };
  }

  listOrders: MarketPort['listOrders'] = (a, b, s) => this.inner.listOrders(a, b, s);
  getOrderLines: MarketPort['getOrderLines'] = (id) => this.inner.getOrderLines(id);
  listClaims: MarketPort['listClaims'] = (a, b) => this.inner.listClaims(a, b);
  predictCategory: MarketPort['predictCategory'] = (n) => this.inner.predictCategory(n);
  getCategoryMeta: MarketPort['getCategoryMeta'] = (c) => this.inner.getCategoryMeta(c);
  // 조회 전용 → 모의 실행에서도 실제 호출
  listShippingPlaces = async () => (this.inner.listShippingPlaces ? this.inner.listShippingPlaces() : { outbound: [], returns: [] });
  listRevenue: MarketPort['listRevenue'] = (a, b) => this.inner.listRevenue(a, b);
  listInquiries: MarketPort['listInquiries'] = (a, b) => this.inner.listInquiries(a, b);

  /** 모의 등록 상품의 옵션명(재시작하면 사라짐 → 옵션 1개로 처리) */
  private dryItems = new Map<string, string[]>();

  getProductStatus: MarketPort['getProductStatus'] = async (id) => {
    if (id.startsWith('DRY-')) {
      const names = this.dryItems.get(id) ?? [''];
      const items = names.map((n, i) => ({ vendorItemId: `DRYVI-${id.slice(4)}-${i + 1}`, itemName: n }));
      return { sellerProductId: id, status: 'APPROVED', rawStatus: 'DRY_RUN', vendorItemIds: items.map((x) => x.vendorItemId), items };
    }
    return this.inner.getProductStatus(id);
  };

  async acknowledge(ids: string[]): Promise<Record<string, MarketResult>> {
    if (this.live('LIVE_FULFILLMENT')) return this.inner.acknowledge(ids);
    return Object.fromEntries(ids.map((id) => [id, this.simulated('acknowledge', { id })]));
  }

  async uploadInvoice(input: InvoiceInput): Promise<MarketResult> {
    if (this.live('LIVE_FULFILLMENT')) return this.inner.uploadInvoice(input);
    return this.simulated('uploadInvoice', { shipmentBoxId: input.shipmentBoxId, courier: input.courierCode });
  }

  async createProduct(payload: unknown): Promise<{ sellerProductId: string; dryRun?: boolean }> {
    if (this.live('LIVE_LISTING')) return this.inner.createProduct(payload);
    this.simulated('createProduct', { name: (payload as any)?.sellerProductName });
    const id = `DRY-${Date.now()}${++this.seq}`;
    this.dryItems.set(id, ((payload as any)?.items ?? []).map((it: any) => String(it.itemName ?? '')));
    return { sellerProductId: id, dryRun: true };
  }

  /**
   * 실제 쿠팡 상품(DRYVI 아님)의 가격·재고·판매중지는 실등록(LIVE_LISTING)만 켜도 실제로 반영한다.
   * 그렇지 않으면 공급처 품절·공급가 상승을 쿠팡에 반영하지 못해 품절 주문·역마진이 생긴다.
   */
  private liveProduct(id: string): boolean {
    return !id.startsWith('DRYVI-') && (this.live('LIVE_PRICING') || this.live('LIVE_LISTING'));
  }

  async updatePrice(id: string, price: number): Promise<MarketResult> {
    if (this.liveProduct(id)) return this.inner.updatePrice(id, price);
    return this.simulated('updatePrice', { id, price });
  }
  async updateQuantity(id: string, qty: number): Promise<MarketResult> {
    if (this.liveProduct(id)) return this.inner.updateQuantity(id, qty);
    return this.simulated('updateQuantity', { id, qty });
  }
  async stopSale(id: string): Promise<MarketResult> {
    if (this.liveProduct(id)) return this.inner.stopSale(id);
    return this.simulated('stopSale', { id });
  }
  async resumeSale(id: string): Promise<MarketResult> {
    if (this.liveProduct(id)) return this.inner.resumeSale(id);
    return this.simulated('resumeSale', { id });
  }
  /** 조회 전용. 모의 등록 상품(DRY-)은 실제 쿠팡에 없음 */
  async getProductDetail(id: string) {
    if (id.startsWith('DRY-') || !this.inner.getProductDetail) return null;
    return this.inner.getProductDetail(id);
  }
  /** 상품 수정은 실등록(LIVE_LISTING)일 때만 실제로 */
  async updateProduct(body: Record<string, any>): Promise<MarketResult> {
    if (this.live('LIVE_LISTING') && this.inner.updateProduct && !String(body.sellerProductId ?? '').startsWith('DRY-')) return this.inner.updateProduct(body);
    return this.simulated('updateProduct', { sellerProductId: body.sellerProductId });
  }
  /** 조회 전용. 모의 등록 상품(DRYVI)은 실제 쿠팡에 없으므로 판단하지 않음 */
  async getItemSaleState(id: string) {
    if (id.startsWith('DRYVI-') || !this.inner.getItemSaleState) return null;
    return this.inner.getItemSaleState(id);
  }
  async replyInquiry(inq: { inquiryId: string; kind: 'product' | 'callcenter' }, text: string): Promise<MarketResult> {
    if (this.live('LIVE_CS')) return this.inner.replyInquiry(inq, text);
    return this.simulated('replyInquiry', { inquiryId: inq.inquiryId, length: text.length });
  }
}
