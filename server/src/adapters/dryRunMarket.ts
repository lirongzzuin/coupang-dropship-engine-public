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
  listRevenue: MarketPort['listRevenue'] = (a, b) => this.inner.listRevenue(a, b);
  listInquiries: MarketPort['listInquiries'] = (a, b) => this.inner.listInquiries(a, b);

  getProductStatus: MarketPort['getProductStatus'] = async (id) => {
    if (id.startsWith('DRY-')) return { sellerProductId: id, status: 'APPROVED', rawStatus: 'DRY_RUN', vendorItemIds: [`DRYVI-${id.slice(4)}`] };
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
    return { sellerProductId: `DRY-${Date.now()}${++this.seq}`, dryRun: true };
  }

  async updatePrice(id: string, price: number): Promise<MarketResult> {
    if (this.live('LIVE_PRICING') && !id.startsWith('DRYVI-')) return this.inner.updatePrice(id, price);
    return this.simulated('updatePrice', { id, price });
  }
  async updateQuantity(id: string, qty: number): Promise<MarketResult> {
    if (this.live('LIVE_PRICING') && !id.startsWith('DRYVI-')) return this.inner.updateQuantity(id, qty);
    return this.simulated('updateQuantity', { id, qty });
  }
  async stopSale(id: string): Promise<MarketResult> {
    if (this.live('LIVE_PRICING') && !id.startsWith('DRYVI-')) return this.inner.stopSale(id);
    return this.simulated('stopSale', { id });
  }
  async resumeSale(id: string): Promise<MarketResult> {
    if (this.live('LIVE_PRICING') && !id.startsWith('DRYVI-')) return this.inner.resumeSale(id);
    return this.simulated('resumeSale', { id });
  }
  async replyInquiry(inq: { inquiryId: string; kind: 'product' | 'callcenter' }, text: string): Promise<MarketResult> {
    if (this.live('LIVE_CS')) return this.inner.replyInquiry(inq, text);
    return this.simulated('replyInquiry', { inquiryId: inq.inquiryId, length: text.length });
  }
}
