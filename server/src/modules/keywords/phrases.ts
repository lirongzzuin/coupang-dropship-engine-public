/**
 * 상품명에서 검색 키워드 후보(1~2어절)를 뽑는 순수 함수.
 * 도매몰 인기 상품명은 "핵심 상품명 + 수식어 + 홍보문구"가 섞여 있어, 빈도 기반으로 반복되는 표현만 남긴다.
 * 최종 판단은 네이버 검색광고의 실제 검색량으로 걸러지므로 여기서는 넉넉히 뽑는다.
 */

/** 키워드로 쓸모없는 단어(홍보·수량·일반 수식어). 설정 discovery.stopwords 로 추가 가능 */
export const DEFAULT_STOPWORDS = [
  '무료배송', '당일발송', '당일출고', '국내발송', '특가', '할인', '세일', '최저가', '정품', '신상', '신제품', '인기', '추천', '베스트',
  '고급', '프리미엄', '대용량', '소용량', '미니', '빅사이즈', '사이즈', '색상', '컬러', '옵션', '선택', '택1', '세트', '개입', '묶음',
  '인쇄가능', '로고인쇄', '주문제작', '판촉물', '단체', '도매', '대량', '업소용', '가정용', '선물용', '사은품', '증정', '이벤트',
  '남녀공용', '공용', '남성', '여성', '남자', '여자', '아동', '성인', '국산', '수입', '중국', '한국', '일본', '정사각', '직사각',
  '블랙', '화이트', '그레이', '베이지', '네이비', '핑크', '블루', '레드', '그린', '브라운', '아이보리', '투명',
  '신형', '구형', '최신형', '업그레이드', '리뉴얼', '휴대용', '다용도', '만능', '심플', '모던', '빈티지', '북유럽', '고정', '용품',
];

export interface PhraseOptions {
  stopwords?: string[];
  /** 반환 최대 개수 */
  limit?: number;
  /** 최소 등장 상품 수(문서 빈도) */
  minDf?: number;
}

function normalize(title: string): string {
  return title
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\[\(【{][^\]\)】}]*[\]\)】}]/g, ' ') // 괄호 안(브랜드·홍보) 제거
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(title: string, stop: Set<string>): string[] {
  return normalize(title)
    .split(' ')
    .filter((t) => {
      const len = [...t].length;
      if (len < 2 || len > 12) return false;
      if (/\d/.test(t)) return false; // 수량·규격·모델번호
      if (/^[a-zA-Z]+$/.test(t) && len < 4) return false; // 짧은 영문(용량 단위 등)
      return !stop.has(t);
    });
}

/** 빈도 높은 1~2어절 표현. 2어절은 "앞 단어 + 뒤 단어"(예: "캠핑 의자") */
export function extractPhrases(titles: string[], opts: PhraseOptions = {}): Array<{ phrase: string; df: number }> {
  const stop = new Set([...(opts.stopwords ?? DEFAULT_STOPWORDS)]);
  const df = new Map<string, number>();
  for (const t of titles) {
    const toks = tokenize(t, stop);
    const seen = new Set<string>();
    toks.forEach((tok, i) => {
      seen.add(tok);
      const next = toks[i + 1];
      if (next && next !== tok) seen.add(`${tok} ${next}`);
    });
    for (const p of seen) df.set(p, (df.get(p) ?? 0) + 1);
  }
  const minDf = opts.minDf ?? (titles.length >= 10 ? 2 : 1);
  return [...df.entries()]
    .filter(([, n]) => n >= minDf)
    // 2어절 우선(구체적), 그다음 빈도
    .sort((a, b) => b[1] * (b[0].includes(' ') ? 1.5 : 1) - a[1] * (a[0].includes(' ') ? 1.5 : 1))
    .slice(0, opts.limit ?? 10)
    .map(([phrase, n]) => ({ phrase, df: n }));
}

/** 카테고리 이름 → 키워드 후보("캠핑의자/테이블" → ["캠핑의자", "테이블"]) */
export function categoryPhrases(name: string, stop: string[] = DEFAULT_STOPWORDS): string[] {
  const s = new Set(stop);
  return name.split(/[\/·,&]|\s+/).map((x) => x.trim()).filter((x) => [...x].length >= 2 && !s.has(x) && !/^기타/.test(x));
}

/** 키워드 점수(0~1): 적정 검색량 + 낮은 경쟁 + 과거 성과 */
export function keywordScore(k: { volume: number | null; competition: string | null; runs: number; passed_total: number; listed_total: number }, sweetSpot = 10000): number {
  const v = k.volume ?? 0;
  const vol = v <= 0 ? 0 : Math.max(0, 1 - Math.abs(Math.log10(v) - Math.log10(sweetSpot)) / 1.5);
  const comp = k.competition === '낮음' ? 1 : k.competition === '중간' ? 0.6 : k.competition === '높음' ? 0.2 : 0.5;
  const perf = k.runs > 0 ? Math.min(1, k.passed_total / k.runs / 3 + k.listed_total * 0.2) : 0.5;
  return Math.round((0.5 * vol + 0.35 * comp + 0.15 * perf) * 1000) / 1000;
}
