/**
 * 공급처(원 판매채널) 포트. 도매꾹·네이버·오너클랜 등은 각각 이 인터페이스를 구현해
 * adapters/ 에 두고 sources/registry 에 등록한다.
 *
 * API 승인이 없어도 동작해야 하므로 발주(placeOrder)·송장(getTracking)은 선택 기능이다.
 * 없으면 주문 엔진이 "구매 대행 작업함(assisted)" 으로 처리한다.
 */

export interface SourceCapabilities {
  search: boolean;
  /** 개별 상품 가격·재고 재조회 */
  detail: boolean;
  /** API 자동 발주 */
  apiOrder: boolean;
  /** API 송장 조회 */
  apiTracking: boolean;
}

export interface SourceProductSummary {
  sourceItemId: string;
  title: string;
  url: string;
  imageUrl?: string;
  price: number;
  shippingFee: number;
}

export interface SourceNoticeItem {
  name: string;
  value: string;
}

export interface SourceProductDetail extends SourceProductSummary {
  status: 'active' | 'soldout' | 'ended';
  stock: number | null;
  categoryPath?: string;
  /** 최저판매준수가(있으면 판매가 하한) */
  minResalePrice?: number;
  imageReuseAllowed: boolean;
  /** 상세 설명 HTML(재사용 허용일 때만 사용) */
  detailHtml?: string;
  images: string[];
  /** 매입 세금계산서 발행 가능 여부 */
  taxInvoice: boolean;
  /** 상품 준비(출고)일 */
  prepDays?: number;
  /** 상품정보제공고시 */
  notice?: { type?: string; items: SourceNoticeItem[] };
  kc?: { certified: boolean; exempt: boolean; certNo?: string; certType?: string };
  brand?: string;
  manufacturer?: string;
  origin?: string;
  sellerScore?: number;
  /** 최소 주문 수량(위탁은 1이어야 함) */
  minOrderQty?: number;
  /** 배송비가 수량만큼 늘어나는지(true면 묶음 옵션 이점 없음) */
  shippingPerUnit?: boolean;
  /** 한 상자에 함께 보낼 수 있는 최대 수량 */
  maxPerBox?: number | null;
  options?: Array<{ name: string; price: number; stock: number | null }>;
}

export interface SourceOrderRequest {
  idempotencyKey: string;
  sourceItemId: string;
  option?: string;
  qty: number;
  receiver: { name: string; phone: string; addr1: string; addr2: string; zip: string };
  deliveryMessage?: string;
}

export interface SourceOrderResult {
  sourceOrderId: string;
  cost: number;
  shippingCost: number;
  /** 주문은 생성됐지만 결제(예치금 차감)가 완료되지 않음 → 사람이 결제 필요 */
  needsPayment?: boolean;
}

export interface SourceTracking {
  courierName: string;
  trackingNo: string;
}

export interface SourceCategory {
  code: string;
  /** 상위>하위 전체 경로 이름 */
  path: string;
  name: string;
  leaf: boolean;
}

export interface SourceAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: SourceCapabilities;
  search(keyword: string, opts?: { limit?: number; minPrice?: number; maxPrice?: number }): Promise<SourceProductSummary[]>;
  getProduct(sourceItemId: string, hint?: { title?: string }): Promise<SourceProductDetail | null>;
  placeOrder?(req: SourceOrderRequest): Promise<SourceOrderResult>;
  getTracking?(sourceOrderId: string): Promise<SourceTracking | null>;
  /** 키워드 자동 발굴용: 카테고리 목록 */
  listCategories?(): Promise<SourceCategory[]>;
  /** 키워드 자동 발굴용: 카테고리 인기 상품 */
  popularItems?(categoryCode: string, limit: number): Promise<SourceProductSummary[]>;
}
