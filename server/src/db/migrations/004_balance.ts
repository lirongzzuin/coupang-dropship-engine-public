import type { Kysely } from 'kysely';

/** 상품성 균형: 출시 후 목표 마크업(경쟁가와의 중간 지점) */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('listings').addColumn('target_markup', 'double precision').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('listings').dropColumn('target_markup').execute();
}
