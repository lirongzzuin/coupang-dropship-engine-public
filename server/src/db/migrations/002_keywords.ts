import { type Kysely, sql } from 'kysely';

/** 자동 발굴 키워드 풀 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('keywords')
    .addColumn('keyword', 'text', (c) => c.primaryKey())
    .addColumn('origin', 'text', (c) => c.notNull()) // manual | category | title | related | winner
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('active')) // active | pinned | paused | blocked
    .addColumn('category', 'text')
    .addColumn('volume', 'integer')
    .addColumn('competition', 'text')
    .addColumn('score', 'double precision', (c) => c.notNull().defaultTo(0))
    .addColumn('runs', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('passed_total', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('listed_total', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('note', 'text')
    .addColumn('discovered_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('last_checked_at', 'timestamptz')
    .addColumn('last_used_at', 'timestamptz')
    .execute();
  await db.schema.createIndex('keywords_status_score').on('keywords').columns(['status', 'score']).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('keywords').ifExists().execute();
}
