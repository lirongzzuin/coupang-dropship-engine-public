import type { Logger } from '../../lib/logger.js';
import { HttpError, RateLimiter, retry } from '../../lib/util.js';
import type {
  SourceAdapter, SourceOrderRequest, SourceOrderResult, SourceOrderState, SourceProductDetail, SourceProductSummary, SourceTracking,
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
  status options { optionAttributes { name value } price quantity status } taxFree adultOnly
  returnable guaranteedShippingPeriod openmarketSellable boxQuantity`;

export class OwnerclanSource implements SourceAdapter {
  readonly id = 'ownerclan';
  readonly displayName = '오너클랜';
  readonly capabilities = { search: true, detail: true, apiOrder: true, apiTracking: true };
  private token?: { value: string; at: number };
  private readonly limiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OwnerclanOptions) {
    this.limiter = new RateLimiter(opts.requestsPerSecond ?? 1); // 실측: 2/s 에서 'Too many requests'
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private get apiUrl(): string {
    return this.opts.sandbox ? 'https://api-sandbox.ownerclan.com/v1/graphql' : 'https://api.ownerclan.com/v1/graphql';
  }
  private get authUrl(): string {
    return this.opts.sandbox ? 'https://auth-sandbox.ownerclan.com/auth' : 'https://auth.ownerclan.com/auth';
  }

  /** 인증에 성공한 계정 유형(seller/vendor) */
  private userType: string | null = null;

  private async getToken(force = false): Promise<string> {
    // JWT 유효기간 1개월(판매사 API 문서) → 보수적으로 6시간마다 재발급, 401이면 즉시 재발급
    if (!force && this.token && Date.now() - this.token.at < 6 * 3600_000) return this.token.value;
    // 계정 유형: 판매사(seller)로 먼저 시도, 아이디 없음이면 vendor 유형으로 재시도(계정마다 다름)
    const types = this.userType ? [this.userType] : ['seller', 'vendor'];
    let res: Response | undefined;
    let text = '';
    for (const userType of types) {
      await this.limiter.take();
      res = await this.fetchImpl(this.authUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: 'ownerclan', userType, username: this.opts.username, password: this.opts.password }),
        signal: AbortSignal.timeout(60_000),
      });
      text = (await res.text()).trim();
      if (res.ok) {
        this.userType = userType;
        break;
      }
      if (!/IDNotFound/.test(text)) break;
    }
    if (!res!.ok) {
      let why = text;
      try {
        why = JSON.parse(text).message ?? text;
      } catch { /* 원문 사용 */ }
      throw new HttpError(res!.status, `오너클랜 인증 실패(${res!.status}): ${why.slice(0, 80)} — OWNERCLAN_USERNAME·PASSWORD 는 오너클랜 사이트 로그인 아이디·비밀번호`);
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
            signal: AbortSignal.timeout(150_000), // 검색이 느림(실측 13~40초+)
          });
          if (res.status === 401 && attempt === 0) {
            attempt++;
            continue;
          }
          const json: any = await res.json().catch(() => ({}));
          if (!res.ok) throw new HttpError(res.status, `오너클랜 API ${res.status}`, json);
          if (json.errors?.some((e: any) => /Not authorized to use API/i.test(e.detail ?? ''))) {
            throw new HttpError(403, '오너클랜 API 사용 권한 없음 — 오너클랜 고객센터에 "API 사용 승인"을 요청하세요(로그인은 정상)', json);
          }
          // 호출 한도 초과는 HTTP 200 + GraphQL 오류로 옴 → 429로 보고 쉬었다가 재시도
          if (json.errors?.some((e: any) => /too many requests/i.test(e.message ?? ''))) throw new HttpError(429, '오너클랜 호출 한도 초과', json);
          if (json.errors?.length) throw new HttpError(400, `오너클랜 GraphQL 오류: ${json.errors.map((e: any) => e.message).join('; ')}`, json);
          return json.data as T;
        }
      },
      { attempts: 4, baseMs: 3000, retryable: (e) => (e instanceof HttpError && (e.status === 429 || e.status >= 500)) || (e as Error)?.name === 'TimeoutError' },
    );
  }

  async search(keyword: string, opts: { limit?: number; minPrice?: number; maxPrice?: number } = {}): Promise<SourceProductSummary[]> {
    const data = await this.gql(
      `query($search:String,$first:Int,$minPrice:Int,$maxPrice:Int){ allItems(search:$search, first:$first, minPrice:$minPrice, maxPrice:$maxPrice, status: available, openmarketSellable:true, shippingLocationType: domestic){ edges { node { ${ITEM_FIELDS} } } } }`,
      { search: keyword, first: opts.limit ?? 20, minPrice: opts.minPrice, maxPrice: opts.maxPrice },
    );
    // 착불(uponArrival) 상품은 고객이 배송비를 또 내게 되므로 제외
    return (data?.allItems?.edges ?? []).filter((e: any) => e.node?.shippingType !== 'uponArrival').map((e: any) => toSummary(e.node));
  }

  async getProduct(key: string): Promise<SourceProductDetail | null> {
    let data: any;
    try {
      data = await this.gql(`query($key:ID!){ item(key:$key){ ${ITEM_FIELDS} } }`, { key });
    } catch (e) {
      // 검색 직후 내려간(판매종료·삭제) 상품 → 없음으로 처리
      if (/No information found|key index not found/i.test(e instanceof Error ? e.message : '')) return null;
      throw e;
    }
    const it = data?.item;
    if (!it) return null;
    const s = toSummary(it);
    const opts = (it.options ?? []).map((o: any) => ({
      name: (o.optionAttributes ?? []).map((a: any) => a.value).filter(Boolean).join(' / '),
      price: Math.round(o.price ?? it.price),
      // 옵션 상태가 판매중이 아니면 재고 0으로 취급(품절 옵션으로 발주 방지)
      stock: o.status && o.status !== 'available' ? 0 : o.quantity ?? null,
    }));
    // 옵션이 여러 개면 기본 옵션 하나를 정해 그 가격·재고로 판매하고 그 옵션으로 발주(옵션 미지정 발주 실패 방지)
    const def = opts.length > 1 ? pickDefaultOption(opts) : undefined;
    const stock = def ? Number(def.stock ?? 0) : opts.reduce((a: number, o: { stock: number | null }) => a + (Number(o.stock) || 0), 0);
    const status: SourceProductDetail['status'] =
      it.shippingType === 'uponArrival' ? 'ended' // 착불로 바뀐 상품은 판매 불가
      : it.status === 'available' ? (stock > 0 || !(it.options ?? []).length ? 'active' : 'soldout')
        : it.status === 'discontinued' ? 'ended' : 'soldout';
    return {
      ...s,
      ...(def ? { price: def.price, defaultOption: def.name } : {}),
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
      options: opts,
    };
  }

  /** 멱등: note(원장주문코드)=idempotencyKey 로 최근 90일 주문 검색 후 없을 때만 생성 */
  async findOrderByKey(idempotencyKey: string): Promise<{ key: string; status: string; amount: number; shipping: number } | null> {
    const now = Math.floor(Date.now() / 1000);
    const data = await this.gql(
      `query($note:String,$from:Timestamp,$to:Timestamp){ allOrders(note:$note, dateFrom:$from, dateTo:$to, first:5){ edges { node { key status products { price quantity } shippingInfo { shippingFee } } } } }`,
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
      sender: { name: req.sender?.name || req.receiver.name, phoneNumber: req.sender?.phone || req.receiver.phone },
      recipient: {
        name: req.receiver.name,
        phoneNumber: req.receiver.phone,
        destinationAddress: { addr1: req.receiver.addr1, addr2: req.receiver.addr2, postalCode: req.receiver.zip },
      },
      products: [{ quantity: req.qty, itemKey: req.sourceItemId, optionAttributes: req.option ? req.option.split(' / ') : [] }],
      note: req.idempotencyKey,
      sellerNote: req.idempotencyKey,
      ordererNote: req.deliveryMessage ?? '',
    };
    // 실 스키마(2026-10 확인): simulateCreateOrder 는 Mutation
    const sim = await this.gql(`mutation($input:OrderInput!){ simulateCreateOrder(input:$input){ itemAmounts { itemKey amount } shippingAmount extraShippingFeeExists } }`, { input });
    const results: any[] = sim?.simulateCreateOrder ?? [];
    const cost = results.reduce((a, r) => a + (r.itemAmounts ?? []).reduce((b: number, x: any) => b + (x.amount ?? 0), 0), 0);
    const shippingCost = results.reduce((a, r) => a + (r.shippingAmount ?? 0), 0);
    const created = await this.gql(
      `mutation($input:OrderInput!,$sim:[CreateOrderSimulationResultInput!]){ createOrder(input:$input, simulationResult:$sim){ key status } }`,
      { input, sim: results },
    );
    const orders: any[] = Array.isArray(created?.createOrder) ? created.createOrder : [created?.createOrder].filter(Boolean);
    if (!orders.length) throw new Error('오너클랜 주문 생성 응답이 비어 있음');
    const needsPayment = orders.some((o) => o.status === 'placed');
    return { sourceOrderId: orders.map((o) => o.key).join(','), cost, shippingCost, needsPayment };
  }

  /**
   * 공급처 주문 취소(고객이 쿠팡에서 취소했을 때). 결제완료(paid) 상태면 즉시 취소,
   * 이미 준비중이면 취소 요청(requestOrderCancellation=true) → 공급사가 수락하면 취소.
   */
  async cancelOrder(sourceOrderId: string, reason: string): Promise<{ ok: boolean; status: string; message: string }> {
    const results: string[] = [];
    let ok = true;
    for (const key of sourceOrderId.split(',')) {
      try {
        const d = await this.gql(`mutation($key:ID!,$input:RequestOrderCancellationInput){ cancelOrder(key:$key, input:$input, requestOrderCancellation:true){ key status } }`,
          { key, input: { cancelReason: reason.slice(0, 100) || '고객 취소' } });
        results.push(String(d?.cancelOrder?.status ?? ''));
      } catch (e) {
        ok = false;
        results.push(e instanceof Error ? e.message.slice(0, 120) : String(e));
      }
    }
    return { ok, status: results.join(','), message: results.join(' / ') };
  }

  async getTracking(sourceOrderId: string): Promise<SourceTracking | null> {
    return (await this.getOrderInfo(sourceOrderId)).tracking;
  }

  /** 주문 상태 + 송장(한 번 조회). 여러 주문이면 가장 앞선 문제 상태(취소) 우선 */
  async getOrderInfo(sourceOrderId: string): Promise<{ state: SourceOrderState; rawStatus: string; tracking: SourceTracking | null }> {
    let tracking: SourceTracking | null = null;
    const states: string[] = [];
    for (const key of sourceOrderId.split(',')) {
      const data = await this.gql(`query($key:String!){ order(key:$key){ status products { trackingNumber shippingCompanyName shippingCompanyCode } } }`, { key });
      states.push(String(data?.order?.status ?? ''));
      const p = (data?.order?.products ?? []).find((x: any) => x.trackingNumber);
      if (p && !tracking) tracking = { courierName: p.shippingCompanyName || p.shippingCompanyCode || '', trackingNo: String(p.trackingNumber).replace(/[^0-9A-Za-z]/g, '') };
    }
    const state: SourceOrderState = states.some((x) => x === 'cancelled') ? 'cancelled'
      : states.some((x) => x === 'cancelRequested') ? 'cancel_requested'
        : states.some((x) => x === 'placed') ? 'unpaid'
          : states.every((x) => ['paid', 'preparing', 'shipped'].includes(x)) ? 'ok' : 'other';
    return { state, rawStatus: states.join(','), tracking };
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

/** 재고 있는 옵션 중 가장 싼 것, 같으면 재고 많은 것 */
export function pickDefaultOption<T extends { name: string; price: number; stock: number | null }>(opts: T[]): T | undefined {
  const inStock = opts.filter((o) => o.name && (o.stock === null || o.stock > 0));
  return [...(inStock.length ? inStock : opts)].sort((a, b) => a.price - b.price || (b.stock ?? 0) - (a.stock ?? 0))[0];
}
