import { type Kysely, sql } from 'kysely';

/**
 * 취소·반품·교환(클레임)을 주문별로 끝까지 추적
 * - order_claims: 쿠팡 접수 1건(receipt) × 주문 1줄. stage = 정규화한 진행 단계, prev_status = 클레임 전 주문 상태(철회 시 복구)
 *   action = 시스템이 한 조치(출고중지완료·이미출고·공급처 취소 요청 등), reship_* = 교환·분실 재발송 공급처 주문
 * - orders.extra_cost: 재발송 등 추가 비용(정산 손익에서 차감)
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('order_claims')
    .addColumn('id', 'serial', (c) => c.primaryKey())
    .addColumn('order_id', 'integer', (c) => c.notNull().references('orders.id').onDelete('cascade'))
    .addColumn('market', 'text', (c) => c.notNull())
    .addColumn('receipt_id', 'text', (c) => c.notNull())
    .addColumn('claim_type', 'text', (c) => c.notNull())
    .addColumn('stage', 'text', (c) => c.notNull())
    .addColumn('raw_status', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('count', 'integer')
    .addColumn('reason', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('fault_by', 'text')
    .addColumn('return_shipping_charge', 'integer')
    .addColumn('prev_status', 'text')
    .addColumn('action', 'text')
    .addColumn('action_note', 'text')
    .addColumn('notified_stage', 'text')
    .addColumn('source_cancel_at', 'timestamptz')
    .addColumn('reship_source_order_id', 'text')
    .addColumn('reship_cost', 'integer')
    .addColumn('reship_tracking', 'text')
    .addColumn('requested_at', 'timestamptz', (c) => c.notNull())
    .addColumn('closed_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull())
    .addUniqueConstraint('order_claims_receipt_uq', ['market', 'receipt_id', 'order_id'])
    .execute();
  await db.schema.createIndex('order_claims_order_idx').on('order_claims').column('order_id').execute();
  await db.schema.alterTable('orders').addColumn('extra_cost', 'integer', (c) => c.notNull().defaultTo(0)).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('orders').dropColumn('extra_cost').execute();
  await sql`DROP TABLE IF EXISTS order_claims`.execute(db);
}
