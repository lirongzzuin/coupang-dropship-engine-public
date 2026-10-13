import type { Kysely } from 'kysely';

/**
 * 개선용 데이터(가벼운 누적) — docs/data.md
 * - daily_metrics: 상품별 하루 1행(가격·주문·매출·이익) → 어떤 상품/가격이 팔렸는지
 * - selection_runs: 선정 1회 1행(검토·통과·등록 수, 탈락 사유, 모델 계수) → 알고리즘 튜닝 근거
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.createTable('daily_metrics')
    .addColumn('day', 'text', (c) => c.notNull())
    .addColumn('listing_id', 'integer', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('sale_price', 'integer', (c) => c.notNull())
    .addColumn('markup', 'double precision')
    .addColumn('orders', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('revenue', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('expected_profit', 'integer', (c) => c.notNull().defaultTo(0))
    .addPrimaryKeyConstraint('daily_metrics_pk', ['day', 'listing_id'])
    .execute();
  await db.schema.createTable('selection_runs')
    .addColumn('run_id', 'text', (c) => c.primaryKey())
    .addColumn('at', 'timestamptz', (c) => c.notNull())
    .addColumn('keywords', 'integer', (c) => c.notNull())
    .addColumn('evaluated', 'integer', (c) => c.notNull())
    .addColumn('passed', 'integer', (c) => c.notNull())
    .addColumn('listed', 'integer', (c) => c.notNull())
    .addColumn('fails', 'jsonb')
    .addColumn('skipped', 'jsonb')
    .addColumn('model', 'jsonb')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('selection_runs').execute();
  await db.schema.dropTable('daily_metrics').execute();
}
