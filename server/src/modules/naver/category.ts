import type { AppContext } from '../../context.js';

/**
 * 스마트스토어 카테고리 매칭.
 * 오너클랜 카테고리 경로는 네이버쇼핑 분류와 같은 체계("생활/건강>문구/사무용품>다이어리/플래너>캘린더/달력" — 운영 데이터 확인 2026-10-15)
 * → 스마트스토어 전체 카테고리(wholeCategoryName)와 경로를 비교해 가장 비슷한 말단 카테고리를 고른다.
 * 공급처 경로가 다른 체계(도매꾹)여도 말단 이름·상품명 단어로 점수를 매긴다. 기준 점수 미만이면 등록하지 않는다(잘못된 카테고리 방지).
 */
export interface NaverCategory {
  id: string;
  name: string;
  wholeCategoryName: string;
}

const CACHE_KEY = 'naver.categories';

/** 스마트스토어 카테고리 목록(7일 캐시) */
export async function naverCategories(ctx: AppContext): Promise<NaverCategory[]> {
  const cached = await ctx.kv.get<{ at: string; list: NaverCategory[] }>(CACHE_KEY);
  if (cached && ctx.clock.now().getTime() - new Date(cached.at).getTime() < 7 * 86400_000 && cached.list.length) return cached.list;
  if (!ctx.naverApi) return cached?.list ?? [];
  const list = await ctx.naverApi.listCategories();
  if (list.length) await ctx.kv.set(CACHE_KEY, { at: ctx.clock.now().toISOString(), list });
  return list;
}

const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
const segs = (path: string) => path.split('>').map(norm).filter(Boolean);
const tokens = (seg: string) => seg.split(/[/·,&]+/).filter((t) => t.length >= 1);

/**
 * 점수(0~1.2): 경로 앞부분 일치(0.5) + 말단 일치(0.3) + 단어 겹침(0.2) + 상품명에 말단 단어(0.1~0.2)
 * 경로가 완전히 같으면 1.0 이상.
 */
export function scoreCategory(cat: NaverCategory, path: string | null | undefined, title: string): number {
  const a = segs(path ?? '');
  const b = segs(cat.wholeCategoryName || cat.name);
  if (!b.length) return 0;
  let s = 0;
  if (a.length) {
    let prefix = 0;
    while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix++;
    // 대분류 이름이 달라도(도매꾹 '생활용품' vs 네이버 '생활/건강') 중간 분류가 같으면 일부 인정
    const sameSegs = b.filter((x) => a.includes(x)).length;
    s += 0.5 * (Math.max(prefix, sameSegs * 0.8) / Math.max(a.length, b.length));
    if (a[a.length - 1] === b[b.length - 1]) s += 0.3;
    const ta = new Set(a.flatMap(tokens));
    const tb = b.flatMap(tokens);
    s += 0.2 * (tb.filter((t) => ta.has(t)).length / Math.max(1, tb.length));
  }
  const leafWords = tokens(b[b.length - 1]!).filter((t) => t.length >= 2);
  const t = norm(title);
  if (leafWords.some((w) => t.includes(w))) s += a.length ? 0.1 : 0.5;
  if (!a.length && b.slice(0, -1).flatMap(tokens).some((w) => w.length >= 2 && t.includes(w))) s += 0.2;
  return s;
}

/** 공급처와 네이버의 카테고리 이름 차이(실측 2026-10-19: 오너클랜 '키홀더' = 네이버 '키링') */
const SYNONYMS: Array<[RegExp, string]> = [[/키홀더/g, '키링']];

/** 의미 없는 두 글자(카테고리 이름에 흔한 말) — 상품명 대조에서 제외 */
const STOP_BIGRAMS = new Set(['용품', '소품', '기타', '생활', '건강', '패션', '잡화', '의류', '세트', '전용']);
const bigrams = (s: string) => {
  const out: string[] = [];
  for (let i = 0; i + 2 <= s.length; i++) out.push(s.slice(i, i + 2));
  return out;
};

/**
 * 상품명과 카테고리가 맞는지: 카테고리 아래 두 단계(중·소분류) 이름의 두 글자 조각이 상품명에 하나라도 있어야 함.
 * 오너클랜 카테고리 자체가 틀린 상품(실측: '실링왁스'→'돌잔치용품>상대여', '욕실 매트'→'여성의류>코디세트')을 걸러냄 —
 * 스마트스토어는 카테고리가 틀리면 판매금지·검색 제외가 될 수 있음
 */
/** 카테고리별로 상품명에 흔히 쓰는 다른 말(키링 = 키홀더·열쇠고리·가방고리·백참) */
const FIT_EXTRA: Record<string, string[]> = { 키링: ['고리', '홀더', '장식', '참'] };

export function titleFits(categoryName: string, title: string): boolean {
  const segs = categoryName.split('>').slice(-2).map(norm);
  const grams = new Set([...segs.flatMap((x) => tokens(x)).flatMap(bigrams), ...segs.flatMap((x) => FIT_EXTRA[x] ?? [])].filter((g) => !STOP_BIGRAMS.has(g)));
  const t = norm(title);
  return [...grams].some((g) => t.includes(g));
}

function bestOf(cats: NaverCategory[], path: string | null | undefined, title: string): { id: string; name: string; score: number } | null {
  let best: { id: string; name: string; score: number } | null = null;
  for (const c of cats) {
    const sc = scoreCategory(c, path, title);
    if (!best || sc > best.score) best = { id: c.id, name: c.wholeCategoryName || c.name, score: sc };
  }
  return best;
}

export function matchCategory(cats: NaverCategory[], path: string | null | undefined, title: string, map: Record<string, string> = {}, minScore = 0.5): { id: string; name: string; score: number } | null {
  // 직접 지정(공급처 경로 → 카테고리ID) 우선
  const direct = path ? map[path] ?? map[path.replace(/\s+/g, '')] : undefined;
  if (direct) {
    const c = cats.find((x) => x.id === direct);
    return { id: direct, name: c?.wholeCategoryName ?? direct, score: 2 };
  }
  const p = path ? SYNONYMS.reduce((acc, [re, to]) => acc.replace(re, to), path) : path;
  const best = bestOf(cats, p, title);
  if (best && best.score >= minScore && titleFits(best.name, title)) return best;
  // 경로로 고른 카테고리가 상품명과 안 맞으면(공급처 분류 오류) 상품명으로 다시 찾되 엄격하게:
  // 같은 대분류 안에서, 말단·상위 분류 이름이 모두 상품명에 있을 때만(점수 0.7). 아니면 등록 안 함(틀린 카테고리는 판매금지 위험)
  const top = p ? segs(p)[0] : undefined;
  const pool = top ? cats.filter((c) => segs(c.wholeCategoryName)[0] === top) : cats;
  const byTitle = bestOf(pool, null, title);
  if (byTitle && byTitle.score >= Math.max(minScore, 0.7) && titleFits(byTitle.name, title)) return byTitle;
  return null;
}
