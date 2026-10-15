import type { AppContext } from '../../context.js';
import { addDays, errMessage } from '../../lib/util.js';
import type { RelatedKeyword } from '../../ports/misc.js';
import type { SourceCategory } from '../../ports/source.js';
import { categoryPhrases, DEFAULT_STOPWORDS, extractPhrases, keywordScore } from './phrases.js';

/**
 * 키워드 자동 발굴·관리.
 *  1) 공급처(도매꾹) 카테고리를 돌아가며 인기 상품명 → 반복 표현 + 카테고리 이름
 *  2) 네이버 검색광고 키워드도구로 실제 월간 검색량·경쟁도 확인 + 연관 키워드까지 수집
 *  3) 적정 검색량·낮은 경쟁·과거 성과로 점수 → 키워드 풀(keywords 테이블)
 *  4) 상품 선정이 매번 풀에서 상위 키워드를 순환해 가져가고, 결과(통과·등록 수)를 다시 점수에 반영
 *  5) 3회 연속 통과 후보가 없는 키워드는 자동 일시중지
 */

export interface DiscoveryResult {
  /** 공급처에서 팔지 않아 제외·정리한 키워드 수 */
  noSupply?: number;
  /** 검색 한도로 이번에 공급처 확인을 못 해 다음 발굴로 미룬 키워드 수 */
  supplyDeferred?: number;
  categories: number;
  hints: number;
  found: number;
  added: number;
  updated: number;
  errors: string[];
}

function allowedCategory(c: SourceCategory, allowTop: string[], blocked: string[]): boolean {
  const top = c.path.split('>')[0] ?? '';
  if (allowTop.length && !allowTop.includes(top)) return false;
  return !blocked.some((b) => b && c.path.includes(b));
}

/** 2·3단계 카테고리(인기순 조회 가능)를 회전하며 이번 실행분을 고른다 */
async function nextCategories(ctx: AppContext, all: SourceCategory[], n: number): Promise<SourceCategory[]> {
  const s = await ctx.settings.get();
  const blocked = [...s.selection.blockedCategoryKeywords, ...s.discovery.blockedCategoryNames];
  const pool = all.filter((c) => {
    const depth = c.code.split('_').filter((x) => x !== '00').length;
    return depth >= 2 && depth <= 3 && allowedCategory(c, s.discovery.allowTopCategories, blocked);
  });
  if (!pool.length) return [];
  // 대분류를 번갈아 섞어(라운드로빈) 한 분류에 몰리지 않게
  const byTop = new Map<string, SourceCategory[]>();
  for (const c of pool) {
    const top = c.path.split('>')[0] ?? '';
    byTop.set(top, [...(byTop.get(top) ?? []), c]);
  }
  const groups = [...byTop.values()];
  const mixed: SourceCategory[] = [];
  for (let i = 0; mixed.length < pool.length; i++) for (const g of groups) if (g[i]) mixed.push(g[i]!);
  pool.splice(0, pool.length, ...mixed);
  const cursor = (await ctx.kv.get<number>('discovery.cursor')) ?? 0;
  const picked = Array.from({ length: Math.min(n, pool.length) }, (_, i) => pool[(cursor + i) % pool.length]!);
  await ctx.kv.set('discovery.cursor', (cursor + picked.length) % pool.length);
  return picked;
}

export async function discoverKeywords(ctx: AppContext): Promise<DiscoveryResult> {
  const s = await ctx.settings.get();
  const d = s.discovery;
  const res: DiscoveryResult = { categories: 0, hints: 0, found: 0, added: 0, updated: 0, errors: [] };
  if (!d.enabled) return res;
  const stop = [...DEFAULT_STOPWORDS, ...d.stopwords];
  const hints = new Map<string, { origin: string; category: string | null }>();

  // 1) 공급처 카테고리·인기 상품명
  for (const src of ctx.sources.list()) {
    if (!src.listCategories || !src.popularItems) continue;
    try {
      let cats = (await ctx.kv.get<{ at: string; list: SourceCategory[] }>(`discovery.categories.${src.id}`)) ?? null;
      if (!cats || ctx.clock.now().getTime() - new Date(cats.at).getTime() > 7 * 86400_000) {
        cats = { at: ctx.clock.now().toISOString(), list: await src.listCategories() };
        await ctx.kv.set(`discovery.categories.${src.id}`, cats);
      }
      for (const c of await nextCategories(ctx, cats.list, d.categoriesPerRun)) {
        res.categories++;
        for (const p of categoryPhrases(c.name, stop)) if (!hints.has(p)) hints.set(p, { origin: 'category', category: c.path });
        try {
          const items = await src.popularItems(c.code, d.itemsPerCategory);
          for (const { phrase } of extractPhrases(items.map((i) => i.title), { stopwords: stop, limit: d.phrasesPerCategory })) {
            if (!hints.has(phrase)) hints.set(phrase, { origin: 'title', category: c.path });
          }
        } catch (e) {
          res.errors.push(`${src.id}/${c.code}: ${errMessage(e)}`);
        }
      }
    } catch (e) {
      res.errors.push(`${src.id} 카테고리: ${errMessage(e)}`);
    }
  }
  // 수동 시드도 연관 키워드 확장 대상
  for (const k of s.selection.seedKeywords) if (k.trim() && !hints.has(k.trim())) hints.set(k.trim(), { origin: 'manual', category: null });

  // 2) 네이버 검색광고로 검증·확장
  const hintList = [...hints.keys()].slice(0, d.maxHintsPerRun);
  res.hints = hintList.length;
  if (!ctx.marketData.keywordStats) {
    res.errors.push('네이버 검색광고 키가 없어 검색량 검증을 못 함(키워드를 그대로 저장하지 않음)');
    return res;
  }
  const found = new Map<string, RelatedKeyword & { origin: string; category: string | null }>();
  const norm = (k: string) => k.replace(/\s+/g, '');
  const hintByNorm = new Map(hintList.map((h) => [norm(h), h]));
  for (let i = 0; i < hintList.length; i += 5) {
    const chunk = hintList.slice(i, i + 5);
    let list: RelatedKeyword[] | null = null;
    try {
      list = await ctx.marketData.keywordStats(chunk);
    } catch (e) {
      res.errors.push(`검색광고: ${errMessage(e)}`);
      if (errMessage(e).includes('429') || errMessage(e).includes('인증')) break;
      continue;
    }
    const overlapTokens = chunk.flatMap((h) => [...h.split(/\s+/), ...(hints.get(h)?.category?.split('>').pop()?.split(/[\/\s]+/) ?? [])]).map(norm).filter((t) => [...t].length >= 2);
    for (const k of list ?? []) {
      const original = hintByNorm.get(norm(k.keyword));
      // 연관 키워드: 힌트·카테고리 단어와 겹칠 때만(“가방” → “보부상가방” O, “사직서” X)
      if (!original && d.relatedRequireOverlap && !overlapTokens.some((t) => norm(k.keyword).includes(t) || t.includes(norm(k.keyword)))) continue;
      const meta = original ? hints.get(original)! : { origin: 'related', category: hints.get(chunk[0]!)?.category ?? null };
      // 사람이 읽기 좋은 띄어쓰기 형태가 있으면 그걸 사용
      const display = original ?? k.keyword;
      if (!found.has(norm(display))) found.set(norm(display), { ...k, keyword: display, ...meta });
    }
  }
  res.found = found.size;

  // 3) 필터·점수·저장
  const blockedWords = [...s.selection.blockedKeywords, ...s.selection.blockedCategoryKeywords, ...stop.filter((w) => w.length >= 3)];
  const now = ctx.clock.now();
  const supply = new SupplyChecker(ctx, d.supplyCheck);
  for (const k of found.values()) {
    if (k.volume < d.minVolume || k.volume > d.maxVolume) continue;
    if (d.excludeHighCompetition && k.competition === '높음') continue;
    if (blockedWords.some((b) => b && norm(k.keyword).includes(norm(b)))) continue;
    if (d.noiseWords.some((w) => w && norm(k.keyword).includes(norm(w)))) continue;
    if ([...norm(k.keyword)].length < 2) continue;
    const existing = await ctx.db.selectFrom('keywords').selectAll().where('keyword', '=', k.keyword).executeTakeFirst();
    // 연관 키워드(검색광고가 붙여 준 단어)는 공급처에서 실제로 파는지 확인(상품명·카테고리에서 나온 키워드는 이미 공급처 상품 기반)
    if (!existing && k.origin === 'related' && !(await supply.ok(k.keyword, 'new'))) {
      // 공급 없음으로 확인된 것만 집계(검색 한도로 이번에 확인 못 한 키워드는 다음 발굴에서 다시)
      if (supply.lastWasDefinitive) res.noSupply = (res.noSupply ?? 0) + 1;
      else res.supplyDeferred = (res.supplyDeferred ?? 0) + 1;
      continue;
    }
    const base = { volume: k.volume, competition: k.competition, last_checked_at: now };
    if (existing) {
      const score = keywordScore({ ...existing, ...base }, d.sweetSpotVolume);
      await ctx.db.updateTable('keywords').set({ ...base, score }).where('keyword', '=', k.keyword).execute();
      res.updated++;
    } else {
      const score = keywordScore({ volume: k.volume, competition: k.competition, runs: 0, passed_total: 0, listed_total: 0 }, d.sweetSpotVolume);
      await ctx.db.insertInto('keywords').values({ keyword: k.keyword, origin: k.origin, category: k.category, ...base, score, discovered_at: now }).onConflict((oc) => oc.column('keyword').doNothing()).execute();
      res.added++;
    }
    // 검색량 이력(월별 추이 계산용)
    await ctx.db.insertInto('market_signals').values({ keyword: k.keyword, kind: 'search_volume', value: k.volume, meta: null, at: now }).execute();
  }
  // 필터 규칙이 바뀐 뒤에도 남아 있는 자동 키워드 정리(고정 키워드는 유지)
  const stale = (await ctx.db.selectFrom('keywords').select('keyword').where('status', '!=', 'pinned').execute())
    .map((r) => r.keyword)
    .filter((kw) => stop.includes(kw) || blockedWords.some((b) => b && norm(kw).includes(norm(b))) || d.noiseWords.some((w) => w && norm(kw).includes(norm(w))));
  if (stale.length) await ctx.db.deleteFrom('keywords').where('keyword', 'in', stale).execute();
  // 예전에 공급처 확인 없이 들어온 미사용 연관 키워드 재확인(남은 검색 횟수만큼, 공급 없으면 정리)
  const unchecked = await ctx.db.selectFrom('keywords').select('keyword').where('origin', '=', 'related').where('status', '=', 'active').where('runs', '=', 0)
    .where((eb) => eb.or([eb('note', 'is', null), eb('note', '!=', SUPPLY_OK)])).orderBy('score', 'desc').execute();
  for (const { keyword } of unchecked) {
    if (!supply.hasBudget('recheck')) break;
    if (await supply.ok(keyword, 'recheck')) await ctx.db.updateTable('keywords').set({ note: SUPPLY_OK }).where('keyword', '=', keyword).execute();
    else if (supply.lastWasDefinitive) {
      await ctx.db.deleteFrom('keywords').where('keyword', '=', keyword).execute();
      res.noSupply = (res.noSupply ?? 0) + 1;
    }
  }
  await prunePool(ctx);
  return res;
}

const SUPPLY_OK = '공급처 상품 확인';

/**
 * 공급처 확인: 검색 결과 상품명에 키워드(띄어쓰기 무시)가 들어간 상품 수를 센다.
 * 검색 실패는 판단 보류(키워드를 버리지 않음), 공급 없음 판정은 rememberDays 동안 기억해 같은 검색을 반복하지 않는다.
 */
class SupplyChecker {
  /** 새 키워드 확인은 한도의 3/4까지(나머지는 예전 키워드 재확인 몫) */
  private used = { new: 0, recheck: 0 };
  private readonly startedAt = Date.now();
  lastWasDefinitive = false;
  constructor(private readonly ctx: AppContext, private readonly cfg: { enabled: boolean; minMatches: number; perRun: number; rememberDays: number; sources: string[]; maxSeconds: number }) {}

  private limit(kind: 'new' | 'recheck'): number {
    const forNew = Math.ceil(this.cfg.perRun * 0.75);
    return kind === 'new' ? forNew : this.cfg.perRun - Math.min(this.used.new, forNew);
  }

  hasBudget(kind: 'new' | 'recheck'): boolean {
    return this.cfg.enabled && this.used[kind] < this.limit(kind) && Date.now() - this.startedAt < this.cfg.maxSeconds * 1000;
  }

  async ok(keyword: string, kind: 'new' | 'recheck' = 'new'): Promise<boolean> {
    this.lastWasDefinitive = false;
    if (!this.cfg.enabled) return true;
    const memo = (await this.ctx.kv.get<Record<string, string>>('discovery.noSupply')) ?? {};
    const since = memo[keyword];
    if (since && this.ctx.clock.now().getTime() - new Date(since).getTime() < this.cfg.rememberDays * 86400_000) {
      this.lastWasDefinitive = true;
      return false;
    }
    if (!this.hasBudget(kind)) return false; // 이번 회차 검색 한도 → 다음 발굴에서 다시
    const s = await this.ctx.settings.get();
    // 빠른 공급처부터(설정 순서), 그다음 상품 선정에 쓰는 나머지 공급처
    const ids = [...new Set([...this.cfg.sources, ...s.selection.sources])].filter((id) => s.selection.sources.includes(id) || this.cfg.sources.includes(id));
    const sources = ids.map((id) => this.ctx.sources.get(id)).filter((x) => !!x);
    if (!sources.length) return true;
    const key = keyword.replace(/\s+/g, '').toLowerCase();
    let matches = 0;
    let searched = 0;
    let complete = true;
    for (const src of sources) {
      if (matches >= this.cfg.minMatches) break;
      if (!this.hasBudget(kind)) {
        complete = false; // 모든 공급처를 못 봄 → 이번엔 판단 보류
        break;
      }
      try {
        this.used[kind]++;
        const items = await src!.search(keyword, { limit: 40 });
        searched++;
        matches += items.filter((i) => i.title.replace(/\s+/g, '').toLowerCase().includes(key)).length;
      } catch (e) {
        complete = false;
        this.ctx.log.warn({ keyword, source: src!.id, err: errMessage(e) }, '키워드 공급처 확인 실패(판단 보류)');
      }
    }
    if (matches >= this.cfg.minMatches) return true;
    if (!searched) return true; // 검색 실패 → 버리지 않음
    if (!complete) return false; // 일부 공급처만 봄 → 다음 회차에 다시

    this.lastWasDefinitive = true;
    await this.ctx.kv.set('discovery.noSupply', { ...memo, [keyword]: this.ctx.clock.now().toISOString() });
    return false;
  }
}

/** 풀 크기 제한: 한 번도 안 쓴 낮은 점수 자동 키워드부터 삭제 */
async function prunePool(ctx: AppContext): Promise<void> {
  const s = await ctx.settings.get();
  const rows = await ctx.db.selectFrom('keywords').select(['keyword']).where('status', '=', 'active').where('runs', '=', 0).orderBy('score', 'desc').execute();
  const total = Number((await ctx.db.selectFrom('keywords').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst())?.n ?? 0);
  const over = total - s.discovery.poolMax;
  if (over <= 0) return;
  const victims = rows.slice(-over).map((r) => r.keyword);
  if (victims.length) await ctx.db.deleteFrom('keywords').where('keyword', 'in', victims).execute();
}

/** 이번 상품 선정에 쓸 키워드: 고정(수동) + 잘 팔린 키워드 + 점수 상위(최근 사용분 제외 순환) */
export async function pickKeywordsForRun(ctx: AppContext, extra: string[] = []): Promise<string[]> {
  const s = await ctx.settings.get();
  const now = ctx.clock.now();
  // 수동 시드는 고정 키워드로 풀에 보관
  for (const k of s.selection.seedKeywords.map((x) => x.trim()).filter(Boolean)) {
    await ctx.db.insertInto('keywords').values({ keyword: k, origin: 'manual', status: 'pinned', discovered_at: now })
      .onConflict((oc) => oc.column('keyword').doUpdateSet({ status: 'pinned' })).execute();
  }
  const pinned = (await ctx.db.selectFrom('keywords').select('keyword').where('status', '=', 'pinned').execute()).map((r) => r.keyword);
  let picked = [...new Set([...pinned, ...extra])];
  if (s.selection.keywordMode === 'auto') {
    const need = Math.max(0, s.discovery.keywordsPerRun - picked.length);
    const cutoff = addDays(now, -s.discovery.reuseDays);
    let auto = await ctx.db.selectFrom('keywords').select('keyword').where('status', '=', 'active')
      .where((eb) => eb.or([eb('last_used_at', 'is', null), eb('last_used_at', '<', cutoff)]))
      .orderBy('score', 'desc').limit(need).execute();
    // 풀이 부족하면 먼저 발굴
    if (auto.length < need && s.discovery.enabled) {
      const r = await discoverKeywords(ctx);
      ctx.log.info({ r }, '키워드 풀 부족 → 자동 발굴');
      auto = await ctx.db.selectFrom('keywords').select('keyword').where('status', '=', 'active')
        .where((eb) => eb.or([eb('last_used_at', 'is', null), eb('last_used_at', '<', cutoff)]))
        .orderBy('score', 'desc').limit(need).execute();
    }
    picked = [...new Set([...picked, ...auto.map((r) => r.keyword)])];
  }
  if (picked.length) await ctx.db.updateTable('keywords').set({ last_used_at: now }).where('keyword', 'in', picked).execute();
  return picked;
}

/** 선정 결과를 키워드 성과에 반영. 3회 이상 쓰고도 통과 후보 0이면 자동 일시중지 */
export async function recordKeywordResults(ctx: AppContext, stats: Map<string, { passed: number; listed: number }>): Promise<void> {
  const s = await ctx.settings.get();
  for (const [kw, st] of stats) {
    const k = await ctx.db.selectFrom('keywords').selectAll().where('keyword', '=', kw).executeTakeFirst();
    if (!k) continue;
    const next = { runs: k.runs + 1, passed_total: k.passed_total + st.passed, listed_total: k.listed_total + st.listed };
    const score = keywordScore({ ...k, ...next }, s.discovery.sweetSpotVolume);
    const pause = k.status === 'active' && next.runs >= s.discovery.pauseAfterEmptyRuns && next.passed_total === 0;
    await ctx.db.updateTable('keywords').set({ ...next, score, ...(pause ? { status: 'paused', note: `${next.runs}회 실행에도 통과 후보 없음` } : {}) }).where('keyword', '=', kw).execute();
  }
}

export async function setKeywordStatus(ctx: AppContext, keyword: string, status: 'active' | 'pinned' | 'paused' | 'blocked'): Promise<void> {
  const now = ctx.clock.now();
  await ctx.db.insertInto('keywords').values({ keyword, origin: 'manual', status, discovered_at: now })
    .onConflict((oc) => oc.column('keyword').doUpdateSet({ status, note: null })).execute();
  // 설정의 시드 키워드와 동기화(고정 해제 시 시드에서도 제거)
  const s = await ctx.settings.get();
  const seeds = s.selection.seedKeywords.filter((k) => k !== keyword);
  if (status === 'pinned') seeds.push(keyword);
  if (seeds.length !== s.selection.seedKeywords.length || status === 'pinned') await ctx.settings.update({ selection: { seedKeywords: [...new Set(seeds)] } });
}
