import type { Kysely } from 'kysely';

/** 알림 방해금지 시간: 밤에 보류한 알림(아침에 모아서 한 번에 보냄) */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('notifications').addColumn('held', 'boolean', (c) => c.notNull().defaultTo(false)).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('notifications').dropColumn('held').execute();
}
