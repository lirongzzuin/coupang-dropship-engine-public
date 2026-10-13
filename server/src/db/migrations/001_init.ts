import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  const ts = (c: any) => c.notNull().defaultTo(sql`now()`);

  await db.schema.createTable('settings').addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('value', 'jsonb', (c) => c.notNull()).addColumn('updated_at', 'timestamptz', ts).execute();

  await db.schema.createTable('kv').addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('value', 'jsonb', (c) => c.notNull()).addColumn('updated_at', 'timestamptz', ts).execute();

  await db.schema.createTable('admin_users')
    .addColumn('id', 'serial', (c) => c.primaryKey())
    .addColumn('username', 'text', (c) => c.notNull().unique())
    .addColumn('password_hash', 'text', (c) => c.notNull())
    .addColumn('totp_secret', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', ts).execute();

  await db.schema.createTable('sessions')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('user_id', 'integer', (c) => c.notNull().references('admin_users.id').onDelete('cascade'))
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', ts).execute();

  await db.schema.createTable('audit_log')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('at', 'timestamptz', ts)
    .addColumn('actor', 'text', (c) => c.notNull())
    .addColumn('action', 'text', (c) => c.notNull())
    .addColumn('target', 'text')
    .addColumn('detail', 'jsonb').execute();

  await db.schema.createTable('source_products')
    .addColumn('id', 'serial', (c) => c.primaryKey())
    .addColumn('source', 'text', (c) => c.notNull())
    .addColumn('source_item_id', 'text', (c) => c.notNull())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('url', 'text', (c) => c.notNull())
    .addColumn('image_url', 'text')
    .addColumn('category_path', 'text')
    .addColumn('price', 'integer', (c) => c.notNull())
    .addColumn('shipping_fee', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('stock', 'integer')
    .addColumn('min_resale_price', 'integer')
    .addColumn('image_reuse_allowed', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('tax_invoice', 'boolean', (c) => c.notNull().defaultTo(true))
    .addColumn('prep_days', 'integer')
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('active'))
    .addColumn('detail', 'jsonb')
    .addColumn('fetched_at', 'timestamptz', ts)
    .addUniqueConstraint('source_products_source_item_uq', ['source', 'source_item_id']).execute();

  await db.schema.createTable('source_price_history')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('source_product_id', 'integer', (c) => c.notNull().references('source_products.id').onDelete('cascade'))
    .addColumn('price', 'integer', (c) => c.notNull())
    .addColumn('shipping_fee', 'integer', (c) => c.notNull())
    .addColumn('stock', 'integer')
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('at', 'timestamptz', ts).execute();

  await db.schema.createTable('market_signals')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('keyword', 'text', (c) => c.notNull())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('value', 'double precision', (c) => c.notNull())
    .addColumn('meta', 'jsonb')
    .addColumn('at', 'timestamptz', ts).execute();
  await db.schema.createIndex('market_signals_kw_kind_at').on('market_signals').columns(['keyword', 'kind', 'at']).execute();

  await db.schema.createTable('candidates')
    .addColumn('id', 'serial', (c) => c.primaryKey())
    .addColumn('source_product_id', 'integer', (c) => c.notNull().references('source_products.id'))
    .addColumn('keyword', 'text', (c) => c.notNull())
    .addColumn('score', 'double precision', (c) => c.notNull())
    .addColumn('signals', 'jsonb', (c) => c.notNull())
    .addColumn('gates', 'jsonb', (c) => c.notNull())
    .addColumn('passed', 'boolean', (c) => c.notNull())
    .addColumn('target_price', 'integer')
    .addColumn('est_profit', 'integer')
    .addColumn('est_margin', 'double precision')
    .addColumn('market_lowest', 'integer')
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('new'))
    .addColumn('run_id', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', ts)
    .addColumn('decided_at', 'timestamptz').execute();

  await db.schema.createTable('listings')
    .addColumn('id', 'serial', (c) => c.primaryKey())
    .addColumn('candidate_id', 'integer', (c) => c.references('candidates.id'))
    .addColumn('source_product_id', 'integer', (c) => c.notNull().references('source_products.id'))
    .addColumn('market', 'text', (c) => c.notNull().defaultTo('coupang'))
    .addColumn('seller_product_id', 'text')
    .addColumn('vendor_item_id', 'text')
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('search_tags', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('category_code', 'text')
    .addColumn('category_name', 'text')
    .addColumn('sale_price', 'integer', (c) => c.notNull())
    .addColumn('floor_price', 'integer', (c) => c.notNull())
    .addColumn('images', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('detail_html', 'text')
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('draft'))
    .addColumn('status_reason', 'text')
    .addColumn('payload', 'jsonb')
    .addColumn('price_changes_date', 'text')
    .addColumn('price_changes_count', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('zero_sale_adjusted', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('dry_run', 'boolean', (c) => c.notNull().defaultTo(true))
    .addColumn('created_at', 'timestamptz', ts)
    .addColumn('updated_at', 'timestamptz', ts)
    .addColumn('listed_at', 'timestamptz').execute();
  await db.schema.createIndex('listings_vendor_item').on('listings').column('vendor_item_id').execute();

  await db.schema.createTable('price_changes')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('listing_id', 'integer', (c) => c.notNull().references('listings.id').onDelete('cascade'))
    .addColumn('old_price', 'integer', (c) => c.notNull())
    .addColumn('new_price', 'integer', (c) => c.notNull())
    .addColumn('reason', 'text', (c) => c.notNull())
    .addColumn('dry_run', 'boolean', (c) => c.notNull())
    .addColumn('at', 'timestamptz', ts).execute();

  await db.schema.createTable('orders')
    .addColumn('id', 'serial', (c) => c.primaryKey())
    .addColumn('market', 'text', (c) => c.notNull())
    .addColumn('market_order_id', 'text', (c) => c.notNull())
    .addColumn('shipment_box_id', 'text', (c) => c.notNull())
    .addColumn('vendor_item_id', 'text', (c) => c.notNull())
    .addColumn('listing_id', 'integer', (c) => c.references('listings.id'))
    .addColumn('source_product_id', 'integer', (c) => c.references('source_products.id'))
    .addColumn('item_name', 'text', (c) => c.notNull())
    .addColumn('qty', 'integer', (c) => c.notNull())
    .addColumn('sale_amount', 'integer', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('status_reason', 'text')
    .addColumn('ordered_at', 'timestamptz', (c) => c.notNull())
    .addColumn('ship_by', 'text')
    .addColumn('receiver_name_enc', 'text')
    .addColumn('receiver_phone_enc', 'text')
    .addColumn('receiver_addr_enc', 'text')
    .addColumn('receiver_zip', 'text')
    .addColumn('delivery_message_enc', 'text')
    .addColumn('address_hash', 'text')
    .addColumn('purchase_strategy', 'text')
    .addColumn('source_order_id', 'text')
    .addColumn('purchase_cost', 'integer')
    .addColumn('purchase_shipping', 'integer')
    .addColumn('expected_cost', 'integer')
    .addColumn('expected_profit', 'integer')
    .addColumn('courier_code', 'text')
    .addColumn('tracking_no', 'text')
    .addColumn('market_status', 'text')
    .addColumn('acked_at', 'timestamptz')
    .addColumn('purchased_at', 'timestamptz')
    .addColumn('tracking_uploaded_at', 'timestamptz')
    .addColumn('delivered_at', 'timestamptz')
    .addColumn('settled_at', 'timestamptz')
    .addColumn('settlement_amount', 'integer')
    .addColumn('profit', 'integer')
    .addColumn('pii_purged_at', 'timestamptz')
    .addColumn('alerted_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', ts)
    .addColumn('updated_at', 'timestamptz', ts)
    .addUniqueConstraint('orders_market_box_item_uq', ['market', 'shipment_box_id', 'vendor_item_id']).execute();
  await db.schema.createIndex('orders_status').on('orders').column('status').execute();

  await db.schema.createTable('order_events')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('order_id', 'integer', (c) => c.notNull().references('orders.id').onDelete('cascade'))
    .addColumn('from_status', 'text')
    .addColumn('to_status', 'text', (c) => c.notNull())
    .addColumn('reason', 'text')
    .addColumn('actor', 'text', (c) => c.notNull())
    .addColumn('at', 'timestamptz', ts).execute();

  await db.schema.createTable('settlements')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('market_order_id', 'text', (c) => c.notNull())
    .addColumn('vendor_item_id', 'text', (c) => c.notNull())
    .addColumn('sale_type', 'text', (c) => c.notNull())
    .addColumn('sale_amount', 'integer', (c) => c.notNull())
    .addColumn('service_fee', 'integer', (c) => c.notNull())
    .addColumn('service_fee_vat', 'integer', (c) => c.notNull())
    .addColumn('settlement_amount', 'integer', (c) => c.notNull())
    .addColumn('delivery_settlement', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('recognized_at', 'text', (c) => c.notNull())
    .addColumn('raw', 'jsonb')
    .addColumn('imported_at', 'timestamptz', ts)
    .addUniqueConstraint('settlements_uq', ['market_order_id', 'vendor_item_id', 'sale_type', 'recognized_at']).execute();

  await db.schema.createTable('inquiries')
    .addColumn('id', 'serial', (c) => c.primaryKey())
    .addColumn('market', 'text', (c) => c.notNull())
    .addColumn('market_inquiry_id', 'text', (c) => c.notNull())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('vendor_item_id', 'text')
    .addColumn('content', 'text', (c) => c.notNull())
    .addColumn('asked_at', 'timestamptz', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('new'))
    .addColumn('draft', 'text')
    .addColumn('answer', 'text')
    .addColumn('answered_at', 'timestamptz')
    .addColumn('dry_run', 'boolean', (c) => c.notNull().defaultTo(true))
    .addUniqueConstraint('inquiries_uq', ['market', 'kind', 'market_inquiry_id']).execute();

  await db.schema.createTable('job_runs')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('job', 'text', (c) => c.notNull())
    .addColumn('started_at', 'timestamptz', ts)
    .addColumn('finished_at', 'timestamptz')
    .addColumn('ok', 'boolean')
    .addColumn('error', 'text')
    .addColumn('stats', 'jsonb').execute();
  await db.schema.createIndex('job_runs_job_started').on('job_runs').columns(['job', 'started_at']).execute();

  await db.schema.createTable('notifications')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('level', 'text', (c) => c.notNull())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('body', 'text', (c) => c.notNull())
    .addColumn('link', 'text')
    .addColumn('delivered', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('at', 'timestamptz', ts).execute();

  await db.schema.createTable('media')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('filename', 'text', (c) => c.notNull())
    .addColumn('content_type', 'text', (c) => c.notNull())
    .addColumn('size', 'integer', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', ts).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const t of ['media', 'notifications', 'job_runs', 'inquiries', 'settlements', 'order_events', 'orders', 'price_changes', 'listings', 'candidates', 'market_signals', 'source_price_history', 'source_products', 'audit_log', 'sessions', 'admin_users', 'kv', 'settings']) {
    await db.schema.dropTable(t).ifExists().execute();
  }
}
