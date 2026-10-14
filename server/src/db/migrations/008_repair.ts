import type { Kysely } from 'kysely';

/**
 * 상품 설정 자동 점검·수정(쿠팡 상품 수정 API, 승인필요)
 * - repair_state: null | requested(쿠팡 심사 중) | failed
 * - repair_note: 무엇을 고쳤는지 / 실패 사유
 * - repair_requested_at, repair_attempts: 재시도 간격·횟수 제한
 * - repair_resume: 수정이 승인되면 판매 재개할지(설정 오류 때문에 멈춘 상품)
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('listings')
    .addColumn('repair_state', 'text')
    .addColumn('repair_note', 'text')
    .addColumn('repair_requested_at', 'timestamptz')
    .addColumn('repair_attempts', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('repair_resume', 'boolean', (c) => c.notNull().defaultTo(false))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const c of ['repair_resume', 'repair_attempts', 'repair_requested_at', 'repair_note', 'repair_state']) await db.schema.alterTable('listings').dropColumn(c).execute();
}
