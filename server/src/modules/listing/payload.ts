import type { Settings } from '../../config/settings.js';
import type { AttributeSpec, CategoryMeta } from '../../ports/market.js';
import type { SourceProductDetail } from '../../ports/source.js';
import { truncate } from '../../lib/util.js';

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
  return {
    displayCategoryCode: Number(p.categoryCode),
    sellerProductName: truncate(p.title, 100),
    vendorId: p.vendorId,
    saleStartedAt: kstLocal(p.now),
    saleEndedAt: '2099-01-01T23:59:59',
    displayProductName: truncate(p.title, 100),
    brand: p.detail?.brand ?? '',
    generalProductName: truncate(p.title, 100),
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
    items: p.options.map((o) => ({
        itemName: truncate(o.itemName, 150),
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
        attributes: buildAttributes(p.meta, p.title, o.units, p.detail?.defaultOption),
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

const COLORS = ['블랙', '화이트', '그레이', '베이지', '네이비', '핑크', '블루', '레드', '그린', '브라운', '아이보리', '옐로우', '퍼플', '민트', '오렌지', '실버', '골드', '투명', '카키', '와인', '차콜', '크림', '검정', '흰색', '회색', '빨강', '파랑', '노랑', '초록', '분홍', '하늘색', '남색', '갈색'];

/**
 * 카테고리 필수 구매옵션(색상·사이즈·수량 등)을 상품명에서 채운다. 쿠팡은 필수 속성이 빠지면 등록을 거부.
 * - 수량: 묶음 수량(n개)
 * - 색상: 기본 옵션·상품명의 색상 단어, 없으면 "멀티"(쿠팡은 '상세페이지 참조' 거부)
 * - 사이즈: 상품명의 규격(44리터, 30x40cm 등), 없으면 FREE
 * - 그 밖의 숫자형 속성(용량·중량 등): 상품명에서 단위가 맞는 숫자를 찾고, 없으면 등록 불가(AttributeError → 다른 후보로)
 */
export function buildAttributes(meta: CategoryMeta, title: string, units: number, optionName?: string): Array<{ attributeTypeName: string; attributeValueName: string }> {
  const specs: AttributeSpec[] = meta.requiredAttributeSpecs ?? meta.requiredAttributes.map((name) => ({ name, dataType: name === '수량' ? 'NUMBER' : 'STRING' }));
  const out: Array<{ attributeTypeName: string; attributeValueName: string }> = [];
  const has = (n: string) => out.some((x) => x.attributeTypeName === n);
  for (const a of specs) {
    const n = a.name;
    if (n === '수량' || (a.dataType === 'NUMBER' && /수량|개수/.test(n))) {
      out.push({ attributeTypeName: n, attributeValueName: `${units}${a.usableUnits?.includes('개') || !a.basicUnit ? '개' : a.basicUnit}` });
    } else if (/색상|컬러/.test(n)) {
      // 쿠팡은 '상세페이지 참조' 같은 의미 없는 옵션값을 거부(실측 2026-10-14) → 기본 옵션·상품명의 색상, 없으면 '멀티'
      out.push({ attributeTypeName: n, attributeValueName: COLORS.find((c) => optionName?.includes(c)) ?? COLORS.find((c) => title.includes(c)) ?? '멀티' });
    } else if (/사이즈|크기/.test(n)) {
      const m = title.match(/(\d+\s*[xX*×]\s*\d+(?:\s*[xX*×]\s*\d+)?\s*(?:cm|mm)?|\d+(?:\.\d+)?\s*(?:리터|L|ml|cm|mm|m)(?![A-Za-z])|(?<![A-Za-z])(?:XS|S|M|L|XL|XXL|FREE)(?![A-Za-z]))/);
      out.push({ attributeTypeName: n, attributeValueName: m ? m[0].replace(/\s+/g, '') : 'FREE' });
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
