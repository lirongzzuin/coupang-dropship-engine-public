import { type Kysely, sql } from 'kysely';

/**
 * 상품 감시·정리(docs/runbook.md "상품 감시·정리")
 * - source_option: 쿠팡에 올린 공급처 옵션(고정). 이 옵션으로만 발주하고, 이 옵션이 품절·삭제되면 판매중지
 * - checked_at / check_fails: 마지막 공급처 확인 성공 시각, 연속 확인 실패 수
 * - order_checked_at: 마지막 주문 가능 점검(공급처 주문 시뮬레이션) 시각
 * - paused_at: 판매중지 시각(장기 판매불가 정리 기준)
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('listings')
    .addColumn('source_option', 'text')
    .addColumn('checked_at', 'timestamptz')
    .addColumn('check_fails', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('order_checked_at', 'timestamptz')
    .addColumn('paused_at', 'timestamptz')
    .execute();
  // 운영 중 상품: 등록 당시 기본 옵션을 고정 옵션으로(공급처 상품 스냅샷 기준)
  await sql`UPDATE listings SET source_option = sp.detail->>'defaultOption'
    FROM source_products sp WHERE sp.id = listings.source_product_id AND listings.status NOT IN ('stopped', 'rejected')
    AND jsonb_typeof(sp.detail) = 'object' AND sp.detail->>'defaultOption' IS NOT NULL`.execute(db);
  await sql`UPDATE listings SET paused_at = updated_at WHERE status = 'paused'`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const c of ['paused_at', 'order_checked_at', 'check_fails', 'checked_at', 'source_option']) {
    await db.schema.alterTable('listings').dropColumn(c).execute();
  }
}
