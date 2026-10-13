import { type Kysely, sql } from 'kysely';

/** 수익 극대화: 마크업 학습, 묶음(수량) 옵션, 실수수료 학습, 원가 탐색 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('listings').addColumn('markup', 'double precision', (c) => c.notNull().defaultTo(0)).execute();
  await db.schema.alterTable('listings').addColumn('price_set_at', 'timestamptz').execute();
  await db.schema.alterTable('listings').addColumn('best_markup', 'double precision').execute();
  await db.schema.alterTable('listings').addColumn('best_daily_profit', 'double precision').execute();
  await db.schema.alterTable('listings').addColumn('fee_rate_actual', 'double precision').execute();
  await db.schema.alterTable('listings').addColumn('cost_scouted_at', 'timestamptz').execute();
  await db.schema
    .createTable('listing_items')
    .addColumn('id', 'serial', (c) => c.primaryKey())
    .addColumn('listing_id', 'integer', (c) => c.notNull().references('listings.id').onDelete('cascade'))
    .addColumn('unit_qty', 'integer', (c) => c.notNull())
    .addColumn('item_name', 'text', (c) => c.notNull())
    .addColumn('vendor_item_id', 'text')
    .addColumn('sale_price', 'integer', (c) => c.notNull())
    .addColumn('floor_price', 'integer', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('listing_items_listing_unit_uq', ['listing_id', 'unit_qty'])
    .execute();
  await db.schema.createIndex('listing_items_vendor_item').on('listing_items').column('vendor_item_id').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('listing_items').ifExists().execute();
  for (const c of ['markup', 'price_set_at', 'best_markup', 'best_daily_profit', 'fee_rate_actual', 'cost_scouted_at']) {
    await db.schema.alterTable('listings').dropColumn(c).execute();
  }
}
