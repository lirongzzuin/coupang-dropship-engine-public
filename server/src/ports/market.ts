/**
 * 판매채널 포트. 쿠팡 외 채널(예: 스마트스토어)을 붙일 때는 이 인터페이스를 구현한다.
 * 모듈 코드는 이 타입에만 의존한다.
 */

export type MarketOrderStatus = 'ACCEPT' | 'INSTRUCT' | 'DEPARTURE' | 'DELIVERING' | 'FINAL_DELIVERY' | 'NONE_TRACKING' | 'CANCELED' | 'UNKNOWN';

export interface MarketReceiver {
  name: string;
  phone: string;
  addr1: string;
  addr2: string;
  zip: string;
}

/** 주문 1줄 = 묶음배송번호(shipmentBoxId) × 옵션(vendorItemId) */
export interface MarketOrderLine {
  marketOrderId: string;
  shipmentBoxId: string;
  vendorItemId: string;
  sellerProductId?: string;
  itemName: string;
  qty: number;
  /** 고객 결제 기준 금액(수량 반영 판매가, 원) */
  paidAmount: number;
  orderedAt: Date;
  status: MarketOrderStatus;
  receiver: MarketReceiver;
  deliveryMessage?: string;
  /** 출고예정일 YYYY-MM-DD */
  shipBy?: string;
  canceled?: boolean;
  invoiceNumber?: string;
}

export interface InvoiceInput {
  shipmentBoxId: string;
  marketOrderId: string;
  vendorItemId: string;
  courierCode: string;
  trackingNo: string;
  /** 한 묶음배송(shipmentBox)에 상품이 여럿이고 따로 보낼 때(공급처가 다름) */
  splitShipping?: boolean;
  /** 같은 묶음의 다른 상품 송장이 이미 등록됨 */
  preSplitShipped?: boolean;
}

export interface MarketResult {
  ok: boolean;
  retryable: boolean;
  message: string;
  dryRun?: boolean;
}

export interface MarketClaim {
  receiptId: string;
  marketOrderId: string;
  vendorItemId?: string;
  type: 'CANCEL' | 'RETURN' | 'EXCHANGE';
  status: string;
  reason: string;
  requestedAt: Date;
}

export interface MarketProductStatus {
  sellerProductId: string;
  /** APPROVED(판매가능) | IN_REVIEW | REJECTED | DRAFT | UNKNOWN */
  status: 'APPROVED' | 'IN_REVIEW' | 'REJECTED' | 'DRAFT' | 'UNKNOWN';
  rawStatus: string;
  vendorItemIds: string[];
  /** 옵션명별 옵션ID(묶음 옵션 매칭용) */
  items?: Array<{ vendorItemId: string; itemName: string }>;
  reason?: string;
}

export interface ItemSaleState {
  onSale: boolean;
  quantity: number | null;
  price: number | null;
  /** 쿠팡에 이 옵션이 없음(Wing에서 삭제 등) — 상품 삭제 여부는 getProductStatus 로 확인 */
  deleted?: boolean;
}

export interface CategoryNoticeMeta {
  noticeCategoryName: string;
  details: Array<{ name: string; required: boolean }>;
}

export interface CategoryMeta {
  code: string;
  notices: CategoryNoticeMeta[];
  /** 필수 구매옵션 속성 이름 */
  requiredAttributes: string[];
  /** 필수 구매옵션 상세(값 형식·단위) */
  requiredAttributeSpecs?: AttributeSpec[];
  /** 이 카테고리에서 쓸 수 있는 모든 구매옵션 이름(선택 포함) */
  attributeNames?: string[];
}

export interface AttributeSpec {
  name: string;
  /** STRING | NUMBER */
  dataType: string;
  basicUnit?: string;
  usableUnits?: string[];
}

export interface RevenueLine {
  marketOrderId: string;
  vendorItemId: string;
  saleType: 'SALE' | 'REFUND';
  saleAmount: number;
  serviceFee: number;
  serviceFeeVat: number;
  settlementAmount: number;
  deliverySettlement: number;
  recognizedAt: string;
  raw: unknown;
}

export interface MarketInquiry {
  inquiryId: string;
  kind: 'product' | 'callcenter';
  vendorItemId?: string;
  content: string;
  askedAt: Date;
  answered: boolean;
}

export interface MarketPort {
  readonly name: string;
  // ── 주문 ──
  listOrders(from: Date, to: Date, status: MarketOrderStatus): Promise<MarketOrderLine[]>;
  getOrderLines(shipmentBoxId: string): Promise<MarketOrderLine[]>;
  acknowledge(shipmentBoxIds: string[]): Promise<Record<string, MarketResult>>;
  uploadInvoice(input: InvoiceInput): Promise<MarketResult>;
  listClaims(from: Date, to: Date): Promise<MarketClaim[]>;
  // ── 상품 ──
  predictCategory(productName: string): Promise<{ code: string; name: string } | null>;
  getCategoryMeta(code: string): Promise<CategoryMeta>;
  /** Wing에 등록된 출고지·반품지(읽기 전용) */
  listShippingPlaces?(): Promise<ShippingPlaces>;
  createProduct(payload: unknown): Promise<{ sellerProductId: string; dryRun?: boolean }>;
  /** 승인 전(임시저장) 상품 삭제 — 등록 사전 점검 정리용 */
  deleteProduct?(sellerProductId: string): Promise<MarketResult>;
  getProductStatus(sellerProductId: string): Promise<MarketProductStatus>;
  updatePrice(vendorItemId: string, price: number): Promise<MarketResult>;
  updateQuantity(vendorItemId: string, qty: number): Promise<MarketResult>;
  stopSale(vendorItemId: string): Promise<MarketResult>;
  resumeSale(vendorItemId: string): Promise<MarketResult>;
  /** 옵션의 실제 판매 상태(쿠팡 기준). 확인할 수 없으면 null */
  getItemSaleState?(vendorItemId: string): Promise<ItemSaleState | null>;
  /** 등록상품 전체 정보(상품 조회 API 응답 data 그대로) — 상품 수정은 이 JSON에서 값만 바꿔 다시 보냄 */
  getProductDetail?(sellerProductId: string): Promise<Record<string, any> | null>;
  /** 상품 수정(승인필요): 조회한 전체 JSON에서 값만 바꿔 전송 → 쿠팡 재심사 후 반영 */
  updateProduct?(body: Record<string, any>): Promise<MarketResult>;
  // ── 정산·CS ──
  listRevenue(fromDate: string, toDate: string): Promise<RevenueLine[]>;
  listInquiries(from: Date, to: Date): Promise<MarketInquiry[]>;
  replyInquiry(inq: { inquiryId: string; kind: 'product' | 'callcenter' }, text: string): Promise<MarketResult>;
}

export interface ShippingPlaces {
  outbound: Array<{ code: string; name: string; usable: boolean }>;
  returns: Array<{ code: string; name: string; usable: boolean; zip: string; address: string; addressDetail: string; phone: string }>;
}
