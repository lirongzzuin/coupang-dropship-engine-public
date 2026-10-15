import type { Kysely } from 'kysely';

/**
 * 송장·배송 추적 보강
 * - courier_name: 공급처가 준 택배사 표기 그대로(쿠팡 코드를 못 맞추면 사람이 고를 때 표시·별칭 학습)
 * - invoice_attempts / invoice_error: 쿠팡 송장 등록 실패 횟수·마지막 사유(반복 실패 알림)
 * - tracking_checked_at: 송장 등록 후 공급처 송장 변경 확인 시각(공급처가 송장을 고치면 쿠팡 송장 수정)
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('orders')
    .addColumn('courier_name', 'text')
    .addColumn('invoice_attempts', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('invoice_error', 'text')
    .addColumn('tracking_checked_at', 'timestamptz')
    .execute();
  // 반품 회수 방식(쿠팡 returnDeliveryType: 전담택배·연동택배·수기관리) — 수기관리면 판매자가 회수를 접수해야 함
  await db.schema.alterTable('order_claims').addColumn('pickup_type', 'text').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('order_claims').dropColumn('pickup_type').execute();
  for (const c of ['tracking_checked_at', 'invoice_error', 'invoice_attempts', 'courier_name']) await db.schema.alterTable('orders').dropColumn(c).execute();
}
