import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/** DB 테이블 타입. 컬럼을 바꾸면 migrations/ 에 새 마이그레이션을 추가하고 여기 타입도 갱신한다. */

type Ts = ColumnType<Date, Date | string | undefined, Date | string>;
type TsNull = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Json<T = unknown> = ColumnType<T, string | T, string | T>;

export interface SettingsTable {
  key: string;
  value: Json;
  updated_at: Ts;
}

export interface AdminUsersTable {
  id: Generated<number>;
  username: string;
  password_hash: string;
  totp_secret: string;
  created_at: Ts;
}

export interface SessionsTable {
  id: string;
  user_id: number;
  expires_at: Ts;
  created_at: Ts;
}

export interface AuditLogTable {
  id: Generated<number>;
  at: Ts;
  actor: string;
  action: string;
  target: string | null;
  detail: Json | null;
}

export interface SourceProductsTable {
  id: Generated<number>;
  source: string;
  source_item_id: string;
  title: string;
  url: string;
  image_url: string | null;
  category_path: string | null;
  price: number;
  shipping_fee: number;
  stock: number | null;
  min_resale_price: number | null;
  /** 상세이미지 재사용 허용(도매꾹 desc.license.usable) */
  image_reuse_allowed: boolean;
  /** 매입 세금계산서 발행 가능(일반과세 판매자) */
  tax_invoice: boolean;
  prep_days: number | null;
  status: string; // active | soldout | ended
  detail: Json | null;
  fetched_at: Ts;
}

export interface SourcePriceHistoryTable {
  id: Generated<number>;
  source_product_id: number;
  price: number;
  shipping_fee: number;
  stock: number | null;
  status: string;
  at: Ts;
}

export interface MarketSignalsTable {
  id: Generated<number>;
  keyword: string;
  kind: string; // search_volume | market_lowest | market_count | google_trend | coupang_lowest | coupang_rocket_ratio | coupang_sales_est | related_of …
  value: number;
  meta: Json | null;
  at: Ts;
}

export interface CandidatesTable {
  id: Generated<number>;
  source_product_id: number;
  keyword: string;
  score: number;
  signals: Json;
  gates: Json;
  passed: boolean;
  target_price: number | null;
  est_profit: number | null;
  est_margin: number | null;
  market_lowest: number | null;
  status: string; // new | approved | rejected | listed
  run_id: string;
  created_at: Ts;
  decided_at: TsNull;
}

export interface ListingsTable {
  id: Generated<number>;
  candidate_id: number | null;
  source_product_id: number;
  market: string;
  seller_product_id: string | null;
  vendor_item_id: string | null;
  title: string;
  search_tags: Json<string[]>;
  category_code: string | null;
  category_name: string | null;
  sale_price: number;
  floor_price: number;
  images: Json<string[]>;
  detail_html: string | null;
  status: string; // draft | pending_approval | active | paused | stopped | rejected
  status_reason: string | null;
  payload: Json | null;
  price_changes_date: string | null;
  price_changes_count: Generated<number>;
  zero_sale_adjusted: Generated<boolean>;
  dry_run: Generated<boolean>;
  created_at: Ts;
  updated_at: Ts;
  listed_at: TsNull;
  /** 판매가 = 하한가 × (1 + markup). 가격 최적화가 학습 */
  markup: Generated<number>;
  price_set_at: TsNull;
  best_markup: number | null;
  best_daily_profit: number | null;
  /** 정산에서 학습한 실제 수수료율(VAT 별도) */
  fee_rate_actual: number | null;
  cost_scouted_at: TsNull;
  /** 출시 기간 후 목표 마크업(하한가와 경쟁가 사이 중간 지점) */
  target_markup: number | null;
  /** 쿠팡에 올린 공급처 옵션(고정) — 이 옵션으로만 발주. 옵션 없는 상품은 null */
  source_option: string | null;
  /** 마지막 공급처 확인(가격·재고·판매 가능) 성공 시각 */
  checked_at: TsNull;
  /** 공급처 확인 연속 실패 수 */
  check_fails: Generated<number>;
  /** 마지막 주문 가능 점검(공급처 주문 시뮬레이션) 시각 */
  order_checked_at: TsNull;
  /** 판매중지 시각(장기 판매불가 정리 기준) */
  paused_at: TsNull;
  /** 상품 설정 자동 수정: null | requested(쿠팡 심사 중) | failed */
  repair_state: string | null;
  repair_note: string | null;
  repair_requested_at: TsNull;
  repair_attempts: Generated<number>;
  /** 수정이 승인되면 판매 재개(설정 오류로 멈춘 상품) */
  repair_resume: Generated<boolean>;}

export interface ListingItemsTable {
  id: Generated<number>;
  listing_id: number;
  /** 이 옵션 1개 주문 시 실제 보내는 수량(묶음 옵션) */
  unit_qty: number;
  item_name: string;
  vendor_item_id: string | null;
  sale_price: number;
  floor_price: number;
  created_at: Ts;
}

export interface PriceChangesTable {
  id: Generated<number>;
  listing_id: number;
  old_price: number;
  new_price: number;
  reason: string;
  dry_run: boolean;
  at: Ts;
}

export interface OrdersTable {
  id: Generated<number>;
  market: string;
  market_order_id: string;
  shipment_box_id: string;
  vendor_item_id: string;
  listing_id: number | null;
  source_product_id: number | null;
  item_name: string;
  qty: number;
  sale_amount: number;
  status: string;
  status_reason: string | null;
  ordered_at: Ts;
  ship_by: string | null;
  receiver_name_enc: string | null;
  receiver_phone_enc: string | null;
  receiver_addr_enc: string | null;
  receiver_zip: string | null;
  delivery_message_enc: string | null;
  address_hash: string | null;
  purchase_strategy: string | null;
  source_order_id: string | null;
  purchase_cost: number | null;
  purchase_shipping: number | null;
  expected_cost: number | null;
  expected_profit: number | null;
  courier_code: string | null;
  tracking_no: string | null;
  market_status: string | null;
  acked_at: TsNull;
  purchased_at: TsNull;
  tracking_uploaded_at: TsNull;
  delivered_at: TsNull;
  settled_at: TsNull;
  settlement_amount: number | null;
  profit: number | null;
  pii_purged_at: TsNull;
  alerted_at: TsNull;
  created_at: Ts;
  updated_at: Ts;
}

export interface OrderEventsTable {
  id: Generated<number>;
  order_id: number;
  from_status: string | null;
  to_status: string;
  reason: string | null;
  actor: string;
  at: Ts;
}

export interface SettlementsTable {
  id: Generated<number>;
  market_order_id: string;
  vendor_item_id: string;
  sale_type: string; // SALE | REFUND
  sale_amount: number;
  service_fee: number;
  service_fee_vat: number;
  settlement_amount: number;
  delivery_settlement: number;
  recognized_at: string;
  raw: Json | null;
  imported_at: Ts;
}

export interface InquiriesTable {
  id: Generated<number>;
  market: string;
  market_inquiry_id: string;
  kind: string; // product | callcenter
  vendor_item_id: string | null;
  content: string;
  asked_at: Ts;
  status: string; // new | drafted | answered | ignored
  draft: string | null;
  answer: string | null;
  answered_at: TsNull;
  dry_run: Generated<boolean>;
}

export interface JobRunsTable {
  id: Generated<number>;
  job: string;
  started_at: Ts;
  finished_at: TsNull;
  ok: boolean | null;
  error: string | null;
  stats: Json | null;
}

export interface NotificationsTable {
  id: Generated<number>;
  level: string; // info | warn | error | action
  title: string;
  body: string;
  link: string | null;
  delivered: boolean;
  at: Ts;
}

export interface MediaTable {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  created_at: Ts;
}

export interface KeywordsTable {
  keyword: string;
  origin: string;
  status: Generated<string>;
  category: string | null;
  volume: number | null;
  competition: string | null;
  score: Generated<number>;
  runs: Generated<number>;
  passed_total: Generated<number>;
  listed_total: Generated<number>;
  note: string | null;
  discovered_at: Ts;
  last_checked_at: TsNull;
  last_used_at: TsNull;
}

export interface KvTable {
  key: string;
  value: Json;
  updated_at: Ts;
}

export interface DB {
  settings: SettingsTable;
  admin_users: AdminUsersTable;
  sessions: SessionsTable;
  audit_log: AuditLogTable;
  source_products: SourceProductsTable;
  source_price_history: SourcePriceHistoryTable;
  market_signals: MarketSignalsTable;
  candidates: CandidatesTable;
  listings: ListingsTable;
  price_changes: PriceChangesTable;
  orders: OrdersTable;
  order_events: OrderEventsTable;
  settlements: SettlementsTable;
  inquiries: InquiriesTable;
  job_runs: JobRunsTable;
  notifications: NotificationsTable;
  media: MediaTable;
  kv: KvTable;
  keywords: KeywordsTable;
  listing_items: ListingItemsTable;
  daily_metrics: DailyMetricsTable;
  selection_runs: SelectionRunsTable;
}

export type OrderRow = Selectable<OrdersTable>;
export type ListingRow = Selectable<ListingsTable>;
export type ListingItemRow = Selectable<ListingItemsTable>;
export type SourceProductRow = Selectable<SourceProductsTable>;
export type CandidateRow = Selectable<CandidatesTable>;
export type NewOrder = Insertable<OrdersTable>;
export type OrderUpdate = Updateable<OrdersTable>;

export interface DailyMetricsTable {
  /** KST YYYY-MM-DD */
  day: string;
  listing_id: number;
  status: string;
  sale_price: number;
  markup: number | null;
  orders: number;
  revenue: number;
  expected_profit: number;
}

export interface SelectionRunsTable {
  run_id: string;
  at: Ts;
  keywords: number;
  evaluated: number;
  passed: number;
  listed: number;
  fails: Json | null;
  skipped: Json | null;
  model: Json | null;
}
