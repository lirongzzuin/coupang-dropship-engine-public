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
  /** 구매확정(스마트스토어) — 정산 예정 금액이 확정됨 */
  decided?: boolean;
  /** 정산 예정 금액(스마트스토어 expectedSettlementAmount) */
  settlementAmount?: number;
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

/**
 * 클레임 진행 단계(쿠팡 상태를 정규화)
 * - cancelled: 쿠팡에서 취소 완료(결제완료 즉시취소·출고중지 완료) — 고객 환불됨
 * - stop_requested: 상품준비중에 고객이 취소 → 출고중지요청(아직 안 보냈으면 출고중지완료, 보냈으면 이미출고 처리 필요)
 * - return_requested: 출고 후 반품 접수(회수 진행) / return_collected: 입고완료(승인하면 환불)
 * - coupang_check: 쿠팡확인요청 / return_done: 반품완료(환불)
 * - exchange_open: 교환 접수·진행 / exchange_done: 교환 완료 / withdrawn: 고객 철회·교환 불가
 */
export type ClaimStage = 'cancelled' | 'stop_requested' | 'return_requested' | 'return_collected' | 'coupang_check' | 'return_done' | 'exchange_open' | 'exchange_done' | 'withdrawn';

export interface MarketClaim {
  receiptId: string;
  marketOrderId: string;
  vendorItemId?: string;
  type: 'CANCEL' | 'RETURN' | 'EXCHANGE';
  /** 쿠팡 원래 상태값(receiptStatus·exchangeStatus) */
  status: string;
  /** 정규화 단계(없으면 type·status 로 추정) */
  stage?: ClaimStage;
  /** 취소·반품·교환 수량 */
  count?: number;
  shipmentBoxId?: string;
  /** 귀책: COUPANG·VENDOR·CUSTOMER·WMS·GENERAL */
  faultBy?: string;
  /** 반품 배송비(+ 판매자 부담, - 고객 부담) */
  returnShippingCharge?: number;
  /** 반품 회수 방식: 전담택배·연동택배·수기관리(판매자가 회수 접수) · '' = 고객 직접 발송·회수 없음 */
  pickupType?: string;
  reason: string;
  requestedAt: Date;
}

export interface MarketProductStatus {
  sellerProductId: string;
  /** APPROVED(판매가능) | IN_REVIEW | REJECTED | DRAFT | UNKNOWN */
  status: 'APPROVED' | 'IN_REVIEW' | 'REJECTED' | 'DRAFT' | 'UNKNOWN';
  rawStatus: string;
  vendorItemIds: string[];
  /** 옵션명별 옵션ID(묶음 옵션 매칭용). sellerCode = 등록 시 붙인 판매자 관리코드(스마트스토어 옵션 매칭) */
  items?: Array<{ vendorItemId: string; itemName: string; sellerCode?: string }>;
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
  /** 판매채널 이름(listings.market·orders.market 값과 같음): coupang | naver */
  readonly name: string;
  /** 화면·알림용 이름 */
  readonly label?: string;
  // ── 주문 ──
  listOrders(from: Date, to: Date, status: MarketOrderStatus): Promise<MarketOrderLine[]>;
  getOrderLines(shipmentBoxId: string): Promise<MarketOrderLine[]>;
  acknowledge(shipmentBoxIds: string[]): Promise<Record<string, MarketResult>>;
  uploadInvoice(input: InvoiceInput): Promise<MarketResult>;
  /** 송장 수정(이미 등록한 송장이 틀렸을 때). 배송지시·배송중·배송완료·업체직송 상태에서만 가능 */
  updateInvoice?(input: InvoiceInput): Promise<MarketResult>;
  listClaims(from: Date, to: Date): Promise<MarketClaim[]>;
  /** 반품·취소 접수 단건(최신 상태). 고객이 철회했으면 stage='withdrawn', 조회할 수 없으면 null */
  getClaim?(receiptId: string): Promise<MarketClaim | null>;
  /** 출고중지완료: 상품준비중 취소 요청 → 아직 보내지 않음(고객 환불 진행) */
  stopShipment?(receiptId: string, count: number): Promise<MarketResult>;
  /** 이미출고: 취소 요청 전에 이미 보냄 → 송장 등록(이후 반품으로 진행) */
  markShippedForClaim?(receiptId: string, courierCode: string, trackingNo: string): Promise<MarketResult>;
  /** 반품 입고 확인 → 반품 승인(환불). 빠른환불 대상이면 쿠팡이 자동 처리 */
  confirmReturn?(receiptId: string, count: number): Promise<MarketResult>;
  /** 판매자 주문 취소(공급처 품절 등). 판매자 점수(주문이행)가 떨어짐 */
  cancelOrder?(input: { marketOrderId: string; vendorItemId: string; qty: number; reason: 'stock' | 'address' | 'price'; shipmentBoxId?: string }): Promise<MarketResult>;
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
