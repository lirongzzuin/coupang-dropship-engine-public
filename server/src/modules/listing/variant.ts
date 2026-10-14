import { sameOption } from '../../adapters/options.js';
import type { SourceNoticeItem, SourceOptionAttr, SourceProductDetail } from '../../ports/source.js';

/**
 * 판매할 공급처 옵션(변형)에서 쿠팡 필수 구매옵션(색상·사이즈) 값을 찾는다.
 * 찾는 순서: 옵션 축(색상·사이즈 등) → 옵션 이름 텍스트("심플바스켓 (3호 화이트)") → 상품명 → 상품정보고시.
 * 옵션이 여러 개인 상품에서 옵션끼리 색상(사이즈)이 다른데 값을 못 찾으면 strict → 등록하지 않는다
 * (자리채움 값 '멀티'·'FREE'로 올리면 구매자가 어떤 색·사이즈가 오는지 모르고, 사람이 공급처에서 살 때도 옵션을 모름).
 */
export interface VariantInfo {
  /** 판매·발주할 옵션 이름(없으면 단일 상품) */
  option?: string;
  attrs: SourceOptionAttr[];
  /** 공급처에 이름 있는 옵션이 여러 개 */
  multi: boolean;
  /** 옵션들 사이에 색상·사이즈 차이가 있음(값을 못 찾으면 등록 불가) */
  colorVaries: boolean;
  sizeVaries: boolean;
  notice: SourceNoticeItem[];
  issue?: string;
}

const COLORS = [
  '블랙', '화이트', '그레이', '베이지', '네이비', '핑크', '블루', '레드', '그린', '브라운', '아이보리', '옐로우', '퍼플', '민트', '오렌지', '실버', '골드',
  '투명', '카키', '와인', '차콜', '크림', '검정', '검정색', '흰색', '회색', '빨강', '빨간색', '파랑', '파란색', '노랑', '노란색', '초록', '초록색', '분홍', '분홍색',
  '하늘색', '남색', '갈색', '보라', '보라색', '주황', '주황색', '연두', '연두색', '라벤더', '머스타드', '코랄', '버건디', '올리브', '청록', '스카이', '멜란지',
  '내추럴', '클리어', '로즈', '샌드', '모카', '오트밀', '딥그린', '다크그레이', '라이트그레이', '실버그레이', '우드', '월넛', '오크', '스틸', '크롬', '무광블랙',
];
const COLOR_AXIS = /색상|컬러|색깔|color/i;
const SIZE_AXIS = /사이즈|크기|규격|호수|치수|size/i;
const MEANINGLESS = /상세|참조|별도|표시|없음|해당|기타|^-$/;

/** 사이즈 표기: 3호 · 30x40cm · 44리터 · 500ml · XL · 2XL · M(95) · 소형/중형/대형 · 미니·점보 */
const SIZE_RE = new RegExp([
  String.raw`\d+(?:\.\d+)?\s*호`,
  String.raw`\d+\s*[xX*×]\s*\d+(?:\s*[xX*×]\s*\d+)?\s*(?:cm|mm|m)?`,
  String.raw`\d+(?:\.\d+)?\s*(?:리터|L|ml|mL|cm|mm|m|인치|평)(?![A-Za-z])`,
  String.raw`(?<![A-Za-z])(?:XXS|XS|S|M|L|XL|XXL|XXXL|[2-5]XL|FREE|F)(?:\(\d+\))?(?![A-Za-z])`,
  String.raw`(?:초|특|왕)?(?:소|중|대)형`,
  '미니', '점보', '특대', '슈퍼싱글', '싱글', '더블', '퀸', '킹',
].map((p) => `(?:${p})`).join('|'));

function clean(v: string, max = 20): string {
  return v.replace(/[()\[\]{}]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 텍스트에서 색상 단어(합성어는 색상으로 끝날 때만: 크림옐로우 O, 블랙박스 X) */
export function findColor(text: string | undefined): string | null {
  if (!text) return null;
  for (const tok of text.split(/[\s/,()\[\]{}+_|·-]+/)) {
    if (!tok) continue;
    const hit = COLORS.find((c) => tok === c || (tok.endsWith(c) && [...tok].length <= 8 && /^[가-힣]+$/.test(tok)));
    if (hit) return tok;
  }
  return null;
}

/** 텍스트에서 사이즈 표기(앞뒤가 글자·숫자면 다른 단어의 일부라 제외) */
export function findSize(text: string | undefined): string | null {
  if (!text) return null;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${SIZE_RE.source})(?![\\p{L}\\p{N}])`, 'u');
  const m = text.match(re);
  return m ? m[0].replace(/\s+/g, '') : null;
}

/** 일반 옵션 축(옵션·제품선택 등)의 값이 숫자뿐이면 사이즈(신발 230·의류 95·100(L) 등) */
const GENERIC_AXIS = /^(옵션|제품선택|선택|종류|타입|type|option)$/i;
function sizeFromAxisValue(a: SourceOptionAttr): string | null {
  const v = a.value.trim();
  if (SIZE_AXIS.test(a.name)) return v || null;
  if (GENERIC_AXIS.test(a.name.trim()) && /^\d{2,3}(?:\(\w+\))?$/.test(v)) return v;
  return null;
}

export function variantOf(detail: SourceProductDetail | null | undefined, optionText?: string): VariantInfo {
  const notice = detail?.notice?.items ?? [];
  if (!detail) return { option: optionText, attrs: [], multi: false, colorVaries: false, sizeVaries: false, notice };
  const named = (detail.options ?? []).filter((o) => o.name);
  const want = optionText ?? detail.defaultOption;
  const chosen = want ? named.find((o) => sameOption(o.name, want)) : named.length === 1 ? named[0] : undefined;
  const colorOfOpt = (o: (typeof named)[number]) => o.attrs?.find((a) => COLOR_AXIS.test(a.name))?.value ?? findColor(o.name);
  const sizeOfOpt = (o: (typeof named)[number]) => o.attrs?.map(sizeFromAxisValue).find(Boolean) ?? findSize(o.name);
  const distinct = (xs: Array<string | null | undefined>) => new Set(xs.map((x) => (x ?? '').replace(/\s/g, ''))).size;
  return {
    option: chosen?.name ?? want,
    attrs: chosen?.attrs ?? [],
    multi: named.length > 1,
    colorVaries: named.length > 1 && distinct(named.map(colorOfOpt)) > 1,
    sizeVaries: named.length > 1 && distinct(named.map(sizeOfOpt)) > 1,
    notice,
    issue: detail.optionIssue,
  };
}

function fromNotice(notice: SourceNoticeItem[], re: RegExp): string | null {
  const it = notice.find((n) => re.test(n.name) && n.value && !MEANINGLESS.test(n.value));
  return it ? clean(it.value, 30) : null;
}

/** 색상 값: 옵션 축 → 옵션 이름 → 상품명 → 고시정보. 못 찾으면 null */
export function colorFor(v: VariantInfo, title: string): string | null {
  const axis = v.attrs.find((a) => COLOR_AXIS.test(a.name) && a.value && !MEANINGLESS.test(a.value));
  // 색상 축 값에 수량 등이 섞이면("화이트 50p") 색상 단어만, 아니면 값 그대로(공급처 고유 색상명)
  if (axis) return findColor(axis.value) ?? clean(axis.value);
  return findColor(v.option) ?? findColor(v.attrs.map((a) => a.value).join(' ')) ?? (v.colorVaries ? null : findColor(title)) ?? fromNotice(v.notice, /색상|컬러/);
}

/** 사이즈 값: 옵션 축 → 옵션 이름 → 상품명 → 고시정보. 못 찾으면 null */
export function sizeFor(v: VariantInfo, title: string): string | null {
  const axis = v.attrs.filter((a) => a.value && !MEANINGLESS.test(a.value)).map(sizeFromAxisValue).find(Boolean);
  if (axis) return clean(axis);
  return findSize(v.option) ?? findSize(v.attrs.map((a) => a.value).join(' ')) ?? (v.sizeVaries ? null : findSize(title)) ?? fromNotice(v.notice, /크기|치수|규격|사이즈/);
}
