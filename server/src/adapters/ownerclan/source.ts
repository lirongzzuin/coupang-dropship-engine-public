import type { Logger } from '../../lib/logger.js';
import { HttpError, RateLimiter, retry } from '../../lib/util.js';
import type {
  SourceAdapter, SourceOrderRequest, SourceOrderResult, SourceProductDetail, SourceProductSummary, SourceTracking,
} from '../../ports/source.js';

/**
 * 오너클랜 판매사 API (GraphQL). 본인 계정 ID/PW로 JWT 발급 → GraphQL 호출.
 * 출처: 오너클랜 API 센터 매뉴얼 OwnerclanAPI_Seller_Manual v0.11.0 (2020-10-21),
 *   https://cdn.ownerclan.com/API%20%EB%A7%A4%EB%89%B4%EC%96%BC.zip (확인 2026-10-13)
 * - 발주: simulateCreateOrder → createOrder(simulationResult 검증) / note(원장주문코드)에 멱등키 저장
 * - 결제: 주문 거래내역은 적립금 사용(reserveTransfer). 생성 후 status 가 'placed'(미처리)면 결제 미완료로 보고 예외 처리
 * - 송장: order.products[].trackingNumber / shippingCompanyName
 * 사양이 바뀌면 이 파일만 수정한다.
 */
export interface OwnerclanOptions {
  username: string;
  password: string;
  sandbox?: boolean;
  logger: Logger;
  fetchImpl?: typeof fetch;
  requestsPerSecond?: number;
}

const ITEM_FIELDS = `key name model production origin price pricePolicy fixedPrice
  category { key name fullName } content shippingFee shippingType images(size: large)
  status options { optionAttributes { name value } price quantity } taxFree adultOnly
  returnable guaranteedShippingPeriod openmarketSellable boxQuantity`;

export class OwnerclanSource implements SourceAdapter {
  readonly id = 'ownerclan';
  readonly displayName = '오너클랜';
  readonly capabilities = { search: true, detail: true, apiOrder: true, apiTracking: true };
  private token?: { value: string; at: number };
  private readonly limiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OwnerclanOptions) {
    this.limiter = new RateLimiter(opts.requestsPerSecond ?? 2);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private get apiUrl(): string {
    return this.opts.sandbox ? 'https://api-sandbox.ownerclan.com/v1/graphql' : 'https://api.ownerclan.com/v1/graphql';
  }
  private get authUrl(): string {
    return this.opts.sandbox ? 'https://auth-sandbox.ownerclan.com/auth' : 'https://auth.ownerclan.com/auth';
  }

  private async getToken(force = false): Promise<string> {
    // JWT 만료 시간은 매뉴얼에 명시 없음 → 6시간마다 재발급, 401이면 즉시 재발급
    if (!force && this.token && Date.now() - this.token.at < 6 * 3600_000) return this.token.value;
    await this.limiter.take();
    const res = await this.fetchImpl(this.authUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'ownerclan', userType: 'seller', username: this.opts.username, password: this.opts.password }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = (await res.text()).trim();
    if (!res.ok) {
      let why = text;
      try {
        why = JSON.parse(text).message ?? text;
      } catch { /* 원문 사용 */ }
      throw new HttpError(res.status, `오너클랜 인증 실패(${res.status}): ${why.slice(0, 80)} — OWNERCLAN_USERNAME 은 오너클랜 판매사 로그인 아이디`);
    }
    let token = text;
    try {
      const j = JSON.parse(text);
      token = typeof j === 'string' ? j : j.token ?? j.accessToken ?? j.data ?? text;
    } catch { /* 토큰 문자열 그대로 */ }
    this.token = { value: String(token), at: Date.now() };
    return this.token.value;
  }

  async gql<T = any>(query: string, variables?: Record<string, unknown>): Promise<T> {
    return retry(
      async () => {
        let attempt = 0;
        while (true) {
          const token = await this.getToken(attempt > 0);
          await this.limiter.take();
          const res = await this.fetchImpl(this.apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ query, variables }),
            signal: AbortSignal.timeout(30_000),
          });
          if (res.status === 401 && attempt === 0) {
            attempt++;
            continue;
          }
          const json: any = await res.json().catch(() => ({}));
          if (!res.ok) throw new HttpError(res.status, `오너클랜 API ${res.status}`, json);
          if (json.errors?.length) throw new HttpError(400, `오너클랜 GraphQL 오류: ${json.errors.map((e: any) => e.message).join('; ')}`, json);
          return json.data as T;
        }
      },
      { attempts: 3, baseMs: 1000, retryable: (e) => e instanceof HttpError && (e.status === 429 || e.status >= 500) },
    );
  }

  async search(keyword: string, opts: { limit?: number; minPrice?: number; maxPrice?: number } = {}): Promise<SourceProductSummary[]> {
    const data = await this.gql(
      `query($search:String,$first:Int,$minPrice:Int,$maxPrice:Int){ allItems(search:$search, first:$first, minPrice:$minPrice, maxPrice:$maxPrice, status: available, openmarketSellable:true, shippingLocationType: domestic){ edges { node { ${ITEM_FIELDS} } } } }`,
      { search: keyword, first: opts.limit ?? 20, minPrice: opts.minPrice, maxPrice: opts.maxPrice },
    );
    return (data?.allItems?.edges ?? []).map((e: any) => toSummary(e.node));
  }

  async getProduct(key: string): Promise<SourceProductDetail | null> {
    const data = await this.gql(`query($key:String!){ item(key:$key){ ${ITEM_FIELDS} } }`, { key });
    const it = data?.item;
    if (!it) return null;
    const s = toSummary(it);
    const stock = (it.options ?? []).reduce((a: number, o: any) => a + (Number(o.quantity) || 0), 0);
    const status: SourceProductDetail['status'] =
      it.status === 'available' ? (stock > 0 || !(it.options ?? []).length ? 'active' : 'soldout')
        : it.status === 'discontinued' ? 'ended' : 'soldout';
    return {
      ...s,
      status,
      stock: (it.options ?? []).length ? stock : null,
      categoryPath: it.category?.fullName ?? it.category?.name,
      minResalePrice: it.pricePolicy === 'fixed' && it.fixedPrice ? Math.round(it.fixedPrice) : undefined,
      // 오너클랜: boxQuantity = 1박스 최대 묶음배송 수량(매뉴얼 v0.11.0)
      shippingPerUnit: false,
      returnable: it.returnable === undefined ? undefined : !!it.returnable,
      maxPerBox: it.boxQuantity ? Number(it.boxQuantity) : null,
      // 위탁 판매용 상품 이미지 제공이 오너클랜 서비스 전제. 단 openmarketSellable=false 는 검색에서 제외
      imageReuseAllowed: it.openmarketSellable !== false,
      detailHtml: it.content ?? undefined,
      images: it.images ?? [],
      taxInvoice: true,
      prepDays: it.guaranteedShippingPeriod ?? undefined,
      manufacturer: it.production ?? undefined,
      origin: it.origin ?? undefined,
      notice: { items: [
        { name: '품명 및 모델명', value: [it.name, it.model].filter(Boolean).join(' / ') },
        { name: '제조국(원산지)', value: it.origin ?? '상세페이지 참조' },
        { name: '제조자(수입자)', value: it.production ?? '상세페이지 참조' },
      ] },
      options: (it.options ?? []).map((o: any) => ({
        name: (o.optionAttributes ?? []).map((a: any) => a.value).filter(Boolean).join(' / '),
        price: Math.round(o.price ?? it.price),
        stock: o.quantity ?? null,
      })),
    };
  }

  /** 멱등: note(원장주문코드)=idempotencyKey 로 최근 90일 주문 검색 후 없을 때만 생성 */
  async findOrderByKey(idempotencyKey: string): Promise<{ key: string; status: string; amount: number; shipping: number } | null> {
    const now = Math.floor(Date.now() / 1000);
    const data = await this.gql(
      `query($note:String,$from:Int,$to:Int){ allOrders(note:$note, dateFrom:$from, dateTo:$to, first:5){ edges { node { key status products { price quantity } shippingInfo { shippingFee } } } } }`,
      { note: idempotencyKey, from: now - 89 * 86400, to: now },
    );
    const node = data?.allOrders?.edges?.[0]?.node;
    if (!node) return null;
    return {
      key: node.key,
      status: node.status,
      amount: (node.products ?? []).reduce((a: number, p: any) => a + Math.round(p.price * p.quantity), 0),
      shipping: Math.round(node.shippingInfo?.shippingFee ?? 0),
    };
  }

  async placeOrder(req: SourceOrderRequest): Promise<SourceOrderResult> {
    const existing = await this.findOrderByKey(req.idempotencyKey);
    if (existing) {
      this.opts.logger.warn({ key: existing.key }, '오너클랜: 동일 멱등키 주문이 이미 존재 → 재생성하지 않음');
      return { sourceOrderId: existing.key, cost: existing.amount, shippingCost: existing.shipping, needsPayment: existing.status === 'placed' };
    }
    const input = {
      recipient: {
        name: req.receiver.name,
        phoneNumber: req.receiver.phone,
        destinationAddress: { addr1: req.receiver.addr1, addr2: req.receiver.addr2, postalCode: req.receiver.zip },
      },
      products: [{ quantity: req.qty, itemKey: req.sourceItemId, ...(req.option ? { optionAttributes: req.option.split(' / ') } : {}) }],
      note: req.idempotencyKey,
      sellerNote: req.idempotencyKey,
      ordererNote: req.deliveryMessage ?? '',
    };
    const sim = await this.gql(`query($input:OrderInput!){ simulateCreateOrder(input:$input){ itemAmounts { itemKey amount } shippingAmount extraShippingFeeExists } }`, { input });
    const results: any[] = sim?.simulateCreateOrder ?? [];
    const cost = results.reduce((a, r) => a + (r.itemAmounts ?? []).reduce((b: number, x: any) => b + (x.amount ?? 0), 0), 0);
    const shippingCost = results.reduce((a, r) => a + (r.shippingAmount ?? 0), 0);
    const created = await this.gql(
      `mutation($input:OrderInput!,$sim:[CreateOrderSimulationResultInput]){ createOrder(input:$input, simulationResult:$sim){ key status } }`,
      { input, sim: results },
    );
    const orders: any[] = Array.isArray(created?.createOrder) ? created.createOrder : [created?.createOrder].filter(Boolean);
    if (!orders.length) throw new Error('오너클랜 주문 생성 응답이 비어 있음');
    const needsPayment = orders.some((o) => o.status === 'placed');
    return { sourceOrderId: orders.map((o) => o.key).join(','), cost, shippingCost, needsPayment };
  }

  async getTracking(sourceOrderId: string): Promise<SourceTracking | null> {
    for (const key of sourceOrderId.split(',')) {
      const data = await this.gql(`query($key:String!){ order(key:$key){ status products { trackingNumber shippingCompanyName } } }`, { key });
      const p = (data?.order?.products ?? []).find((x: any) => x.trackingNumber);
      if (p) return { courierName: p.shippingCompanyName ?? '', trackingNo: String(p.trackingNumber).replace(/\D/g, '') };
    }
    return null;
  }
}

function toSummary(it: any): SourceProductSummary {
  return {
    sourceItemId: String(it.key),
    title: String(it.name ?? ''),
    url: `https://www.ownerclan.com/V2/product/view.php?selfcode=${encodeURIComponent(it.key)}`,
    imageUrl: it.images?.[0],
    price: Math.round(it.price ?? 0),
    shippingFee: it.shippingType === 'free' ? 0 : Math.round(it.shippingFee ?? 0),
  };
}
