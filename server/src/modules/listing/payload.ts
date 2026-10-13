import type { Settings } from '../../config/settings.js';
import type { CategoryMeta } from '../../ports/market.js';
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
        parallelImported: 'NOT_PARALLELIMPORTED',
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
        attributes: [{ attributeTypeName: '수량', attributeValueName: `${o.units}개` }],
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
