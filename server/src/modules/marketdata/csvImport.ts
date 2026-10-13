import type { AppContext } from '../../context.js';

/**
 * 쿠팡 판매량 추정 CSV 임포트(외부 분석 툴 내보내기 파일).
 * 툴마다 열 이름이 달라 "열 이름 후보"로 자동 인식한다. 새 툴은 COLUMN_ALIASES 에 추가.
 * 값은 추정치이므로 market_signals.kind='coupang_sales_est' 로만 저장(선정 가중치 기본 0).
 */
const COLUMN_ALIASES = {
  keyword: ['키워드', 'keyword', '검색어', '상품키워드'],
  sales: ['판매량', '월판매량', '예상판매량', '추정판매량', 'sales', 'monthly_sales', '월 판매량'],
};

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',' || ch === '\t') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

export async function importCoupangSalesCsv(ctx: AppContext, text: string, toolName = 'unknown'): Promise<{ imported: number; skipped: number }> {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('데이터 행이 없습니다');
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const find = (aliases: string[]) => header.findIndex((h) => aliases.some((a) => h === a.toLowerCase() || h.replace(/\s/g, '') === a.toLowerCase().replace(/\s/g, '')));
  const ki = find(COLUMN_ALIASES.keyword);
  const si = find(COLUMN_ALIASES.sales);
  if (ki < 0 || si < 0) throw new Error(`열을 찾을 수 없습니다. 필요: 키워드(${COLUMN_ALIASES.keyword.join('/')}), 판매량(${COLUMN_ALIASES.sales.join('/')})`);
  let imported = 0, skipped = 0;
  const now = ctx.clock.now();
  for (const r of rows.slice(1)) {
    const kw = (r[ki] ?? '').trim();
    const v = Number((r[si] ?? '').replace(/[^\d.]/g, ''));
    if (!kw || !Number.isFinite(v) || (r[si] ?? '').trim() === '') {
      skipped++;
      continue;
    }
    await ctx.db.insertInto('market_signals').values({ keyword: kw, kind: 'coupang_sales_est', value: v, meta: JSON.stringify({ tool: toolName }), at: now }).execute();
    imported++;
  }
  return { imported, skipped };
}
