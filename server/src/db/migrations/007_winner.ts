import type { Kysely } from 'kysely';

/**
 * 아이템위너 대응(쿠팡 OPEN API로는 위너 여부를 알 수 없음 → Wing 가격관리에서 본 위너 가격을 입력)
 * - winner_status: winner | not_winner | null(미확인)
 * - winner_price: 위너의 판매가+배송비(원) — 가격 자동 조정의 상한
 * - winner_checked_at: 입력 시각(오래되면 상한으로 쓰지 않음)
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('listings')
    .addColumn('winner_status', 'text')
    .addColumn('winner_price', 'integer')
    .addColumn('winner_checked_at', 'timestamptz')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const c of ['winner_checked_at', 'winner_price', 'winner_status']) await db.schema.alterTable('listings').dropColumn(c).execute();
}
