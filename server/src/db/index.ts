import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, PostgresDialect } from 'kysely';
import { type Migration, type MigrationProvider, Migrator } from 'kysely/migration';
import pg from 'pg';
import * as m001 from './migrations/001_init.js';
import * as m002 from './migrations/002_keywords.js';
import * as m003 from './migrations/003_profit.js';
import * as m004 from './migrations/004_balance.js';
import type { DB } from './schema.js';

export type Database = Kysely<DB>;

/** 새 마이그레이션은 여기에 순서대로 추가한다 */
const MIGRATIONS: Record<string, Migration> = {
  '001_init': m001,
  '002_keywords': m002,
  '003_profit': m003,
  '004_balance': m004,
};

class StaticProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return MIGRATIONS;
  }
}

/**
 * DATABASE_URL 이 있으면 PostgreSQL, 없으면 PGlite.
 * dataDir === ':memory:' 이면 메모리 DB(테스트용).
 */
export function createDb(opts: { databaseUrl?: string; dataDir: string }): Database {
  if (opts.databaseUrl) {
    // bigint/numeric 을 number로 받기(금액은 정수 원 단위라 안전)
    pg.types.setTypeParser(20, (v) => Number(v));
    pg.types.setTypeParser(1700, (v) => Number(v));
    return new Kysely<DB>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: opts.databaseUrl, max: 10 }) }) });
  }
  let client: PGlite;
  if (opts.dataDir === ':memory:') client = new PGlite();
  else {
    const dir = join(opts.dataDir, 'pglite');
    mkdirSync(dir, { recursive: true });
    client = new PGlite(dir);
  }
  return new Kysely<DB>({ dialect: new PGliteDialect({ pglite: client }) });
}

export async function migrate(db: Database): Promise<string[]> {
  const migrator = new Migrator({ db, provider: new StaticProvider() });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error;
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}
