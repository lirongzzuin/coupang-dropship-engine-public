import type { Settings } from '../../config/settings.js';
import type { AttributeSpec, CategoryMeta } from '../../ports/market.js';
import type { SourceProductDetail } from '../../ports/source.js';
import { truncate } from '../../lib/util.js';
import { productNameFor } from './text.js';
import { colorFor, sizeFor, variantOf } from './variant.js';

/**
 * 쿠팡 상품 생성 페이로드.
 * 필드 출처: https://developers.coupang.com/ko/api/products/product-creation (확인 2026-10-13)
 * 사양 변경 시 이 파일만 수정.
 */
export interface PayloadInput {
  vendorId: string;
  title: string;
  categoryCode: string;
  /** 판매 옵션(묶음 수량별) */
  options: Array<{ units: number; salePrice: number; itemName: string }>;
  stock: number;
  images: string[];
  detailHtml: string;
  tags: string[];
  meta: CategoryMeta;
  detail: SourceProductDetail | null;
  sourceProductId: number;
  now: Date;
}

export function buildCoupangPayload(s: Settings, p: PayloadInput): Record<string, unknown> {
  const c = s.coupang;
  const prepDays = Math.min(30, (p.detail?.prepDays ?? 1) + s.listing.shippingBufferDays);
  const ten = (n: number) => Math.round(n / 10) * 10;
  // 구매옵션은 원래 상품명에서 뽑고(색상·사이즈 등), 상품명에서는 그 옵션 값을 뺀다(쿠팡: 상품명·옵션 단어 중복 금지)
  const attrs = p.options.map((o) => buildAttributes(p.meta, p.title, o.units, p.detail));
  const name = truncate(productNameFor(p.title, attrs.flat().map((a) => a.attributeValueName)), 100);
  return {
    displayCategoryCode: Number(p.categoryCode),
    sellerProductName: name,
    vendorId: p.vendorId,
    saleStartedAt: kstLocal(p.now),
    saleEndedAt: '2099-01-01T23:59:59',
    displayProductName: name,
    brand: p.detail?.brand ?? '',
    generalProductName: name,
    productGroup: '',
    deliveryMethod: 'SEQUENCIAL',
    deliveryCompanyCode: c.deliveryCompanyCode,
    deliveryChargeType: 'FREE',
    deliveryCharge: 0,
    freeShipOverAmount: 0,
    deliveryChargeOnReturn: c.returnCharge,
    remoteAreaDeliverable: 'N',
    unionDeliveryType: 'NOT_UNION_DELIVERY',
    returnCenterCode: c.returnCenterCode,
    returnChargeName: c.returnChargeName,
    companyContactNumber: c.companyContactNumber,
    returnZipCode: c.returnZipCode,
    returnAddress: c.returnAddress,
    returnAddressDetail: c.returnAddressDetail,
    returnCharge: c.returnCharge,
    outboundShippingPlaceCode: c.outboundShippingPlaceCode,
    vendorUserId: c.vendorUserId,
    requested: true,
    items: p.options.map((o, i) => ({
        itemName: optionItemName(attrs[i]!, o.units),
        originalPrice: ten(Math.max(o.salePrice * s.pricing.originalPriceMultiplier, o.salePrice)),
        salePrice: ten(o.salePrice),
        maximumBuyCount: Math.max(0, Math.min(99999, Math.floor(p.stock / o.units))),
        maximumBuyForPerson: s.listing.maxBuyPerPerson,
        maximumBuyForPersonPeriod: 1,
        outboundShippingTimeDay: prepDays,
        // 단위수량: 쿠팡이 개당 단가를 계산·표시(묶음은 개당 가격이 낮아 유리)
        unitCount: o.units,
        adultOnly: 'EVERYONE',
        taxType: 'TAX',
        parallelImported: 'NOT_PARALLEL_IMPORTED',
        overseasPurchased: 'NOT_OVERSEAS_PURCHASED',
        pccNeeded: false,
        externalVendorSku: `SP-${p.sourceProductId}-${o.units}`,
        // GTIN 정책(2026-08-01 API 적용): 공식 식별자가 없는 상품에 임의 번호 입력 금지
        barcode: '',
        emptyBarcode: true,
        emptyBarcodeReason: '공식 바코드 없음(위탁 판매 상품)',
        certifications: p.detail?.kc?.certified && p.detail.kc.certNo
          ? [{ certificationType: p.detail.kc.certType ?? 'KC_CERTIFICATION', certificationCode: p.detail.kc.certNo }]
          : [{ certificationType: 'NOT_REQUIRED', certificationCode: '' }],
        searchTags: p.tags.slice(0, 20),
        images: p.images.slice(0, 10).map((url, i) => ({ imageOrder: i, imageType: i === 0 ? 'REPRESENTATION' : 'DETAIL', vendorPath: url })),
        notices: buildNotices(p.meta, p.detail, c.companyContactNumber),
        attributes: attrs[i],
        contents: [{ contentsType: 'HTML', contentDetails: [{ content: p.detailHtml, detailType: 'TEXT' }] }],
        offerCondition: 'NEW',
      })),
  };
}

/**
 * 고시정보 매핑: 카테고리 메타의 고시 카테고리 중 공급처 고시 유형과 이름이 맞는 것을 고르고,
 * 각 항목은 공급처 고시값(이름 부분일치) → 알려진 필드 → "상세페이지 참조" 순으로 채운다.
 */
export function buildNotices(meta: CategoryMeta, detail: SourceProductDetail | null, contact: string): Array<Record<string, string>> {
  if (!meta.notices.length) return [];
  const want = (detail?.notice?.type ?? '').replace(/\s/g, '');
  const cat = meta.notices.find((n) => want && n.noticeCategoryName.replace(/\s/g, '').includes(want))
    ?? meta.notices.find((n) => n.noticeCategoryName.includes('기타')) ?? meta.notices[0]!;
  const items = detail?.notice?.items ?? [];
  const norm = (s: string) => s.replace(/[\s()/·]/g, '');
  return cat.details.map((d) => {
    const hit = items.find((i) => i.value && (norm(i.name).includes(norm(d.name)) || norm(d.name).includes(norm(i.name))));
    let value = hit?.value;
    if (!value) {
      if (d.name.includes('전화') || d.name.includes('상담')) value = contact || '상세페이지 참조';
      else if (d.name.includes('제조국') || d.name.includes('원산지')) value = detail?.origin ?? '';
      else if (d.name.includes('제조자') || d.name.includes('수입자')) value = detail?.manufacturer ?? '';
      else if (d.name.includes('인증')) value = detail?.kc?.certNo ? `KC ${detail.kc.certNo}` : '해당사항 없음';
    }
    return { noticeCategoryName: cat.noticeCategoryName, noticeCategoryDetailName: d.name, content: value || '상세페이지 참조' };
  });
}

function kstLocal(d: Date): string {
  return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 19);
}

export class AttributeError extends Error {}

/**
 * 쿠팡 옵션명(itemName): 구매옵션 값만(예: "블랙 소 1개", "화이트 3호 2개", 단일이면 "1개").
 * 상품명 전체를 옵션명에 넣으면 상품명 단어가 모두 옵션과 겹쳐 Wing에 "상품명에서 옵션과 중복된 단어를 지워주세요"가 뜬다(실측 2026-10-14).
 * 수량은 마지막에, 자리채움 값(멀티·FREE)은 뺀다. 같은 상품 안에서 묶음 수량이 달라 이름이 겹치지 않는다.
 */
export function optionItemName(attrs: Array<{ attributeTypeName: string; attributeValueName: string }>, units: number): string {
  const values = attrs
    .filter((a) => !/수량|개수/.test(a.attributeTypeName) && a.attributeValueName && !['멀티', 'FREE'].includes(a.attributeValueName))
    .map((a) => a.attributeValueName.trim());
  return truncate([...new Set(values), `${units}개`].join(' '), 150);
}

/**
 * 카테고리 필수 구매옵션(색상·사이즈·수량 등)을 채운다. 쿠팡은 필수 속성이 빠지면 등록을 거부.
 * 4번째 인자: 공급처 상품 상세(옵션·고시정보 사용) 또는 옵션 이름(문자열)
 * - 수량: 묶음 수량(n개)
 * - 색상·사이즈: 판매할 공급처 옵션의 축(색상=화이트, 사이즈=3호) → 옵션 이름("심플바스켓 (3호 화이트)") → 상품명 → 고시정보 (variant.ts)
 *   · 옵션이 여러 개이고 옵션끼리 색상(사이즈)이 다른데 값을 못 찾으면 등록 불가(AttributeError → 다른 후보로)
 *   · 단일 상품이라 값이 없으면 색상 '멀티'·사이즈 'FREE'(쿠팡은 '상세페이지 참조' 같은 값을 거부, 실측 2026-10-14)
 * - 그 밖의 숫자형 속성(용량·중량 등): 상품명에서 단위가 맞는 숫자를 찾고, 없으면 등록 불가
 */
export function buildAttributes(meta: CategoryMeta, title: string, units: number, source?: SourceProductDetail | string | null): Array<{ attributeTypeName: string; attributeValueName: string }> {
  const specs: AttributeSpec[] = meta.requiredAttributeSpecs ?? meta.requiredAttributes.map((name) => ({ name, dataType: name === '수량' ? 'NUMBER' : 'STRING' }));
  const v = typeof source === 'string' ? variantOf(null, source) : variantOf(source ?? null);
  const optionName = v.option;
  if (v.issue) throw new AttributeError(v.issue);
  const out: Array<{ attributeTypeName: string; attributeValueName: string }> = [];
  const has = (n: string) => out.some((x) => x.attributeTypeName === n);
  for (const a of specs) {
    const n = a.name;
    if (n === '수량' || (a.dataType === 'NUMBER' && /수량|개수/.test(n))) {
      out.push({ attributeTypeName: n, attributeValueName: `${units}${a.usableUnits?.includes('개') || !a.basicUnit ? '개' : a.basicUnit}` });
    } else if (/색상|컬러/.test(n)) {
      const c = colorFor(v, title);
      if (!c && v.colorVaries) throw new AttributeError(`필수 구매옵션 '${n}': 공급처 옵션(${optionName ?? '?'})에서 색상을 찾지 못함 — 옵션마다 색상이 달라 임의값으로 올리지 않음`);
      out.push({ attributeTypeName: n, attributeValueName: c ?? '멀티' });
    } else if (/사이즈|크기/.test(n)) {
      const z = sizeFor(v, title);
      if (!z && v.sizeVaries) throw new AttributeError(`필수 구매옵션 '${n}': 공급처 옵션(${optionName ?? '?'})에서 사이즈를 찾지 못함 — 옵션마다 사이즈가 달라 임의값으로 올리지 않음`);
      out.push({ attributeTypeName: n, attributeValueName: z ?? 'FREE' });
    } else if (a.dataType === 'NUMBER') {
      const unitsRe = (a.usableUnits?.length ? a.usableUnits : a.basicUnit ? [a.basicUnit] : []).map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      const m = unitsRe ? title.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${unitsRe})`, 'i')) : null;
      if (!m) throw new AttributeError(`필수 속성 '${n}' 값을 상품명에서 찾지 못함`);
      out.push({ attributeTypeName: n, attributeValueName: `${m[1]}${m[2]}` });
    } else if (optionName) {
      out.push({ attributeTypeName: n, attributeValueName: optionName.slice(0, 30) });
    } else {
      // 알 수 없는 필수 문자 속성(모델명 등)은 임의값을 넣지 않고 이 상품을 건너뜀
      throw new AttributeError(`필수 속성 '${n}' 값을 정할 수 없음`);
    }
  }
  // 묶음 옵션은 '수량'으로 구분해야 쿠팡이 받음 → 필수가 아니어도 카테고리에 있으면 넣는다
  if (!has('수량') && (!specs.length || meta.attributeNames?.includes('수량'))) out.push({ attributeTypeName: '수량', attributeValueName: `${units}개` });
  return out;
}

/** 이 카테고리에서 묶음(2개·3개) 옵션을 구분할 수 있는가(수량 구매옵션 존재) */
export function supportsBundles(meta: CategoryMeta): boolean {
  if (meta.attributeNames) return meta.attributeNames.includes('수량');
  return meta.requiredAttributes.includes('수량') || !meta.requiredAttributes.length;
}
