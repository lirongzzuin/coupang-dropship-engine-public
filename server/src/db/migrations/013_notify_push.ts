import type { Kysely } from 'kysely';

/**
 * 알림 분리: 모든 알림은 DB(관리 화면)에 남기고, 바로 확인해야 하는 것만 텔레그램으로 보낸다.
 * pushed=false 인 알림은 텔레그램 전송 대상이 아니었음(전송 실패와 구분 — 알림 통로 고장 감지에서 제외).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('notifications').addColumn('pushed', 'boolean', (c) => c.notNull().defaultTo(true)).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('notifications').dropColumn('pushed').execute();
}
