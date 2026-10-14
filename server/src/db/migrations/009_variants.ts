import { type Kysely, sql } from 'kysely';

/**
 * 여러 공급처 옵션(색상·사이즈 등)을 쿠팡 옵션으로 함께 판매
 * - listing_items.source_option: 이 쿠팡 옵션이 발주할 공급처 옵션('' = 상품의 고정 옵션 하나 — 기존 상품)
 * - item_status / item_reason: 옵션별 판매 상태(한 옵션만 품절이면 그 옵션만 판매중지)
 * - 유니크: (상품, 묶음 수량) → (상품, 묶음 수량, 공급처 옵션)
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('listing_items')
    .addColumn('source_option', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('item_status', 'text', (c) => c.notNull().defaultTo('active'))
    .addColumn('item_reason', 'text')
    .execute();
  await sql`ALTER TABLE listing_items DROP CONSTRAINT IF EXISTS listing_items_listing_unit_uq`.execute(db);
  await db.schema.alterTable('listing_items').addUniqueConstraint('listing_items_listing_unit_option_uq', ['listing_id', 'unit_qty', 'source_option']).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE listing_items DROP CONSTRAINT IF EXISTS listing_items_listing_unit_option_uq`.execute(db);
  await db.deleteFrom('listing_items').where('source_option', '!=', '').execute();
  await db.schema.alterTable('listing_items').addUniqueConstraint('listing_items_listing_unit_uq', ['listing_id', 'unit_qty']).execute();
  for (const c of ['item_reason', 'item_status', 'source_option']) await db.schema.alterTable('listing_items').dropColumn(c).execute();
}
