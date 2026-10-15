/**
 * 택배사 이름·코드 → 쿠팡 택배사 코드.
 * 공급처(오너클랜·도매꾹)가 주는 택배사 표기는 제각각이라(이름·약칭·옛 이름·숫자 코드) 여러 단계로 맞춘다.
 *
 * 1) 관리자가 정한 별칭(설정 orders.courierAliases — 처음 보는 택배사를 화면에서 고르면 자동 저장)
 * 2) 쿠팡 코드 그대로(CJGLS 등)
 * 3) 쿠팡 공식 이름·흔한 별칭 정확히 일치
 * 4) 숫자 코드(국내 배송조회 표준 코드: 04=CJ대한통운 등)
 * 5) 이름 안에 포함된 가장 긴 별칭(예: "CJ대한통운(주)" → CJ대한통운)
 *
 * 출처: 쿠팡 택배사 코드 https://developers.coupang.com/ko/api/logistics/courier-code (확인 2026-10-14)
 */

/** 쿠팡 공식 택배사(국내 위주 + 해외 주요). [코드, 쿠팡 표기] */
export const COUPANG_COURIERS: ReadonlyArray<readonly [string, string]> = [
  ['CJGLS', 'CJ대한통운'], ['HYUNDAI', '롯데택배'], ['HANJIN', '한진택배'], ['KGB', '로젠택배'], ['EPOST', '우체국'],
  ['KDEXP', '경동택배'], ['DAESIN', '대신택배'], ['ILYANG', '일양택배'], ['CHUNIL', '천일특송'], ['HDEXP', '합동택배'],
  ['KUNYOUNG', '건영택배'], ['DONGBU', '드림택배'], ['CVS', 'CVS택배'], ['BGF', 'BGF포스트'], ['NHLOGIS', '농협택배'],
  ['HONAM', '우리택배'], ['SLX', 'SLX택배'], ['HANDEX', '한덱스'], ['YONGMA', '용마로지스'], ['SEBANG', '세방택배'],
  ['HOMEPICK', '홈픽택배'], ['HOMEPICKTODAY', '홈픽오늘도착'], ['KURLYNEXTMILE', '컬리넥스트마일'], ['TEAMFRESH', '팀프레시'],
  ['CHAINLOGIS', '두발히어로(4시간당일택배)'], ['VROONG', '부릉'], ['HILOGIS', 'Hi택배'], ['GOODSTOLUCK', '굿투럭'],
  ['ANYTRACK', '애니트랙'], ['WOORIHB', '우리한방택배'], ['IK', 'IK물류'], ['KGBLS', 'KGB로지스'], ['KGBPS', 'KGB택배'],
  ['YELLOW', '옐로우캡'], ['INNOGIS', 'GTX로지스'], ['CSLOGIS', 'SC로지스'], ['AJOU', '아주택배'], ['GLOVIS', '현대글로비스'],
  ['SELC', '삼성로지텍'], ['HANSSEM', '한샘'], ['CASA', '신세계까사'], ['LGE', 'LG전자'], ['KT', 'kt express'],
  ['DIRECT', '업체직송'], ['REGISTPOST', '우편등기'], ['EMS', '우체국 EMS'], ['LOTTEGLOBAL', '롯데글로벌'],
  ['DHL', 'DHL'], ['UPS', 'UPS'], ['FEDEX', 'FEDEX'], ['TNT', 'TNT'], ['USPS', 'USPS'], ['CAINIAO', 'CAINIAO'],
  ['QXPRESS', '큐익스프레스'], ['PANTOS', '범한판토스'], ['SFEXPRESS', '순풍택배'], ['OCS', 'ocs코리아'],
];

const OFFICIAL_CODES = new Set(COUPANG_COURIERS.map(([c]) => c));

/** 흔한 표기·옛 이름 → 쿠팡 코드(공식 이름은 자동 포함) */
const ALIASES: Record<string, string> = {
  // CJ대한통운
  대한통운: 'CJGLS', CJ: 'CJGLS', CJ택배: 'CJGLS', CJGLS: 'CJGLS', 씨제이대한통운: 'CJGLS', 씨제이: 'CJGLS', CJLOGISTICS: 'CJGLS', 대한통운택배: 'CJGLS',
  // 롯데택배(회사명 롯데글로벌로지스, 옛 현대택배)
  롯데: 'HYUNDAI', 롯데글로벌로지스: 'HYUNDAI', 롯데로지스틱스: 'HYUNDAI', 현대택배: 'HYUNDAI', 롯데택배국내: 'HYUNDAI', LOTTE: 'HYUNDAI',
  // 한진
  한진: 'HANJIN', 한진택배: 'HANJIN', 한진로지스: 'HANJIN',
  // 로젠
  로젠: 'KGB', 로젠택배: 'KGB', LOGEN: 'KGB', ILOGEN: 'KGB',
  // 우체국
  우체국택배: 'EPOST', 우체국소포: 'EPOST', 우편택배: 'EPOST', 우체국등기소포: 'EPOST', EPOST: 'EPOST', KOREAPOST: 'EPOST', 우편등기: 'REGISTPOST', 등기우편: 'REGISTPOST',
  우체국EMS: 'EMS', EMS: 'EMS',
  // 화물·지역
  경동: 'KDEXP', 경동화물: 'KDEXP', 경동택배: 'KDEXP', 대신: 'DAESIN', 대신화물: 'DAESIN', 대신택배: 'DAESIN',
  일양: 'ILYANG', 일양로지스: 'ILYANG', 일양택배: 'ILYANG', 천일: 'CHUNIL', 천일택배: 'CHUNIL', 천일특송: 'CHUNIL',
  합동: 'HDEXP', 합동택배: 'HDEXP', 건영: 'KUNYOUNG', 건영택배: 'KUNYOUNG',
  // 드림택배(옛 KG로지스·동부택배·옐로우캡 일부)
  드림: 'DONGBU', 드림택배: 'DONGBU', KG로지스: 'DONGBU', 동부택배: 'DONGBU', 동부익스프레스: 'DONGBU',
  // 편의점
  CVS택배: 'CVS', 편의점택배: 'CVS', GS편의점택배: 'CVS', GS25편의점택배: 'CVS', GSPOSTBOX: 'CVS', GS택배: 'CVS', CVSNET: 'CVS',
  CU편의점택배: 'BGF', CU택배: 'BGF', CUPOST: 'BGF', BGF포스트: 'BGF',
  // 기타 국내
  농협: 'NHLOGIS', 농협택배: 'NHLOGIS', 우리택배: 'HONAM', 호남택배: 'HONAM', 한덱스: 'HANDEX', 용마로지스: 'YONGMA', 세방: 'SEBANG',
  홈픽: 'HOMEPICK', 홈픽택배: 'HOMEPICK', 컬리: 'KURLYNEXTMILE', 팀프레시: 'TEAMFRESH', 두발히어로: 'CHAINLOGIS', 굿투럭: 'GOODSTOLUCK',
  애니트랙: 'ANYTRACK', 우리한방택배: 'WOORIHB', SLX: 'SLX', 큐익스프레스: 'QXPRESS', QXPRESS: 'QXPRESS',
  // 송장 없는 배송(업체 직접·퀵·화물차) — 쿠팡은 배송조회 불가로 처리
  업체직송: 'DIRECT', 직접배송: 'DIRECT', 직접전달: 'DIRECT', 자체배송: 'DIRECT', 업체배송: 'DIRECT', 퀵서비스: 'DIRECT', 퀵배송: 'DIRECT', 용달: 'DIRECT',
};

/** 국내 배송조회 표준 숫자 코드(스마트택배 등에서 쓰는 코드) → 쿠팡 코드 */
const NUMERIC: Record<string, string> = {
  '01': 'EPOST', '04': 'CJGLS', '05': 'HANJIN', '06': 'KGB', '08': 'HYUNDAI', '11': 'ILYANG', '12': 'EMS', '13': 'DHL',
  '17': 'CHUNIL', '18': 'KUNYOUNG', '20': 'HANDEX', '21': 'FEDEX', '22': 'DAESIN', '23': 'KDEXP', '24': 'CVS', '25': 'TNT',
  '26': 'USPS', '32': 'HDEXP', '40': 'GOODSTOLUCK', '43': 'ANYTRACK', '44': 'SLX', '45': 'HONAM', '46': 'BGF', '47': 'WOORIHB',
  '53': 'NHLOGIS', '54': 'HOMEPICK', '71': 'IK',
};

/** 비교용 정규화: 공백·괄호·법인 표기 제거, 영문 대문자 */
export function normCourier(s: string): string {
  return s
    .replace(/\(주\)|㈜|주식회사|\(유\)/g, '')
    .replace(/[\s.\-_·,()[\]{}]/g, '')
    .toUpperCase();
}

/** 정규화 이름 → 코드(공식 이름 + 별칭). 긴 이름부터 비교하도록 정렬 */
const TABLE: Array<[string, string]> = (() => {
  const m = new Map<string, string>();
  for (const [code, name] of COUPANG_COURIERS) m.set(normCourier(name), code);
  for (const [name, code] of Object.entries(ALIASES)) m.set(normCourier(name), code);
  return [...m.entries()].sort((a, b) => b[0].length - a[0].length);
})();

export interface CourierMatch {
  code: string;
  name: string;
  via: 'alias' | 'code' | 'name' | 'numeric' | 'contains';
}

export function courierName(code: string): string {
  return COUPANG_COURIERS.find(([c]) => c === code)?.[1] ?? code;
}

/**
 * 택배사 → 쿠팡 코드. 이름과 공급처 코드를 둘 다 넣으면 이름 → 코드 순으로 시도.
 * 모르면 null(사람이 화면에서 한 번 고르면 별칭으로 저장돼 다음부터 자동)
 */
export function resolveCourier(input: { name?: string | null; code?: string | null }, userAliases: Record<string, string> = {}): CourierMatch | null {
  const user = new Map(Object.entries(userAliases).map(([k, v]) => [normCourier(k), v]));
  const tries = [input.name, input.code].map((x) => (x ?? '').trim()).filter(Boolean);
  for (const raw of tries) {
    const n = normCourier(raw);
    if (!n) continue;
    const u = user.get(n);
    if (u) return { code: u, name: raw, via: 'alias' };
    if (OFFICIAL_CODES.has(n)) return { code: n, name: courierName(n), via: 'code' };
    const exact = TABLE.find(([k]) => k === n);
    if (exact) return { code: exact[1], name: raw, via: 'name' };
    const num = NUMERIC[n.padStart(2, '0')];
    if (/^\d{1,2}$/.test(n) && num) return { code: num, name: courierName(num), via: 'numeric' };
  }
  // 포함 비교: 가장 긴 이름이 이김("우체국EMS"가 "우체국"보다 우선), 길이가 같으면 사용자 별칭 우선
  const all: Array<[string, string, boolean]> = [...[...user.entries()].map(([k, v]) => [k, v, true] as [string, string, boolean]), ...TABLE.map(([k, v]) => [k, v, false] as [string, string, boolean])]
    .sort((a, b) => b[0].length - a[0].length || Number(b[2]) - Number(a[2]));
  for (const raw of tries) {
    const n = normCourier(raw);
    const hit = all.find(([k]) => k.length >= 2 && n.includes(k));
    if (hit) return { code: hit[1], name: raw, via: hit[2] ? 'alias' : 'contains' };
  }
  return null;
}
