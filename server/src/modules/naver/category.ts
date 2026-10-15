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

export function matchCategory(cats: NaverCategory[], path: string | null | undefined, title: string, map: Record<string, string> = {}, minScore = 0.5): { id: string; name: string; score: number } | null {
  // 직접 지정(공급처 경로 → 카테고리ID) 우선
  const direct = path ? map[path] ?? map[path.replace(/\s+/g, '')] : undefined;
  if (direct) {
    const c = cats.find((x) => x.id === direct);
    return { id: direct, name: c?.wholeCategoryName ?? direct, score: 2 };
  }
  let best: { id: string; name: string; score: number } | null = null;
  for (const c of cats) {
    const sc = scoreCategory(c, path, title);
    if (!best || sc > best.score) best = { id: c.id, name: c.wholeCategoryName || c.name, score: sc };
  }
  return best && best.score >= minScore ? best : null;
}
