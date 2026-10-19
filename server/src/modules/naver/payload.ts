import type { Settings } from '../../config/settings.js';
import type { SourceProductDetail } from '../../ports/source.js';

/**
 * 스마트스토어 상품 등록 요청(POST /v2/products) 만들기.
 * 출처: 커머스API 상품 등록 스키마(확인 2026-10-15). 사양 변경 시 이 파일만 수정.
 *
 * - 옵션: 공급처 옵션(색상·사이즈)·묶음 수량을 조합형 옵션으로(옵션 1~2단). 옵션마다 판매자 관리코드 `NVI{listing_items.id}`
 *   → 주문의 optionManageCode 로 어떤 공급처 옵션·수량인지 되찾는다
 * - 가격: 판매가 = 가장 싼 옵션, 나머지는 옵션가(+차액). 스마트스토어 정책상 옵션가는 판매가의 ±50% 이내 → 넘는 옵션은 호출 전에 뺀다
 * - 배송: 무료배송(원가에 포함), 제주·도서산간 추가 배송비, 반품·교환 배송비, 출고지·반품지 주소록
 * - 상품정보제공고시: 기타 재화(ETC)
 */
export interface NaverItem {
  id: number;
  units: number;
  option: string;
  salePrice: number;
  stock: number | null;
}

export interface NaverPayloadInput {
  title: string;
  categoryId: string;
  items: NaverItem[];
  images: string[];
  detailHtml: string;
  detail: SourceProductDetail | null;
  listingId: number;
  shippingAddressId?: number;
  returnAddressId?: number;
}

/** 옵션가 정책(판매가의 ±50%)에 맞는 옵션만: 가장 싼 옵션 기준으로 50% 넘게 비싼 옵션(큰 묶음 등) 제외 */
export function withinOptionPriceRule<T extends { salePrice: number }>(items: T[]): T[] {
  if (!items.length) return items;
  const base = Math.min(...items.map((i) => i.salePrice));
  return items.filter((i) => i.salePrice - base <= base * 0.5);
}

/** 옵션값: 특수문자 정리, 25자 이내, 같은 값은 번호 붙여 구분 */
export function optionLabel(text: string): string {
  return text.replace(/[^\w가-힣\s()/+.\-#]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 25) || '기본';
}

function originArea(origin: string | undefined): { originAreaCode: string; content?: string } {
  const o = (origin ?? '').trim();
  if (!o) return { originAreaCode: '03' }; // 기타-상세 설명에 표시
  if (/국산|국내|한국|대한민국/.test(o)) return { originAreaCode: '00' };
  return { originAreaCode: '04', content: o.slice(0, 50) }; // 기타-직접 입력(수입산 코드는 수입사 필수라 쓰지 않음)
}

const ten = (n: number) => Math.round(n / 10) * 10;

export function buildNaverPayload(s: Settings, p: NaverPayloadInput): Record<string, unknown> {
  if (!p.items.length) throw new Error('옵션 없음');
  if (!p.images.length) throw new Error('대표 이미지 없음');
  const items = [...p.items].sort((a, b) => a.salePrice - b.salePrice || a.units - b.units);
  const base = ten(items[0]!.salePrice);
  if (items.some((i) => ten(i.salePrice) - base > base * 0.5)) throw new Error('옵션가가 판매가의 50%를 넘는 옵션이 있음');
  const phone = s.naver.asPhone || s.coupang.companyContactNumber;
  const stockOf = (i: NaverItem) => Math.max(0, Math.min(999, i.stock === null ? 999 : Math.floor(i.stock / i.units)));
  const variants = [...new Set(items.map((i) => i.option).filter(Boolean))];
  const units = [...new Set(items.map((i) => i.units))];
  let optionInfo: Record<string, unknown> | undefined;
  let sellerManagementCode = `NVL${p.listingId}`;
  if (items.length === 1) {
    // 옵션 없는 상품: 주문의 sellerProductCode 로 옵션을 되찾음
    sellerManagementCode = `NVI${items[0]!.id}`;
  } else {
    const twoLevel = variants.length > 1 && units.length > 1;
    const names = twoLevel ? { optionGroupName1: '옵션', optionGroupName2: '수량' } : variants.length > 1 ? { optionGroupName1: '옵션' } : { optionGroupName1: '수량' };
    const seen = new Set<string>();
    optionInfo = {
      optionCombinationSortType: 'CREATE',
      optionCombinationGroupNames: names,
      useStockManagement: true,
      optionCombinations: items.map((i) => {
        let n1 = variants.length > 1 ? optionLabel(i.option) : `${i.units}개`;
        const n2 = twoLevel ? `${i.units}개` : undefined;
        let k = 2;
        while (seen.has(`${n1}|${n2 ?? ''}`)) n1 = `${optionLabel(i.option).slice(0, 22)} ${k++}`;
        seen.add(`${n1}|${n2 ?? ''}`);
        return { optionName1: n1, ...(n2 ? { optionName2: n2 } : {}), stockQuantity: stockOf(i), price: ten(i.salePrice) - base, usable: true, sellerManagerCode: `NVI${i.id}` };
      }),
    };
  }
  const totalStock = Math.min(99999, items.reduce((a, i) => a + stockOf(i), 0));
  const d = p.detail;
  const name = p.title.slice(0, 100);
  return {
    originProduct: {
      statusType: 'SALE',
      saleType: 'NEW',
      leafCategoryId: p.categoryId,
      name,
      detailContent: p.detailHtml,
      images: {
        representativeImage: { url: p.images[0] },
        ...(p.images.length > 1 ? { optionalImages: p.images.slice(1, 10).map((url) => ({ url })) } : {}),
      },
      salePrice: base,
      stockQuantity: totalStock,
      deliveryInfo: {
        deliveryType: 'DELIVERY',
        deliveryAttributeType: 'NORMAL',
        deliveryCompany: 'CJGLS',
        deliveryFee: {
          deliveryFeeType: 'FREE',
          deliveryFeePayType: 'PREPAID',
          ...(s.naver.remoteAreaExtraFee > 0 ? { deliveryFeeByArea: { deliveryAreaType: 'AREA_2', area2extraFee: s.naver.remoteAreaExtraFee } } : {}),
        },
        claimDeliveryInfo: {
          returnDeliveryFee: s.coupang.returnCharge,
          exchangeDeliveryFee: s.naver.exchangeFee,
          ...(p.shippingAddressId ? { shippingAddressId: p.shippingAddressId } : {}),
          ...(p.returnAddressId ? { returnAddressId: p.returnAddressId } : {}),
        },
      },
      detailAttribute: {
        afterServiceInfo: { afterServiceTelephoneNumber: phone, afterServiceGuideContent: s.naver.asGuide },
        originAreaInfo: originArea(d?.origin),
        sellerCodeInfo: { sellerManagementCode },
        minorPurchasable: true,
        taxType: 'TAX',
        purchaseQuantityInfo: { maxPurchaseQuantityPerOrder: Math.max(1, s.listing.maxBuyPerPerson) },
        ...(optionInfo ? { optionInfo } : {}),
        // 브랜드는 넣지 않음(네이버 브랜드 DB와 다르면 상표 도용으로 보일 수 있음), 제조사만
        ...(d?.manufacturer ? { naverShoppingSearchInfo: { manufacturerName: d.manufacturer } } : {}),
        productInfoProvidedNotice: {
          productInfoProvidedNoticeType: 'ETC',
          etc: {
            returnCostReason: '0',
            noRefundReason: '0',
            qualityAssuranceStandard: '0',
            compensationProcedure: '0',
            troubleShootingContents: '0',
            itemName: name.slice(0, 100),
            modelName: '상세페이지 참조',
            manufacturer: d?.manufacturer || '상세페이지 참조',
            afterServiceDirector: phone,
            customerServicePhoneNumber: phone,
          },
        },
      },
    },
    smartstoreChannelProduct: {
      naverShoppingRegistration: s.naver.naverShopping,
      channelProductDisplayStatusType: 'ON',
    },
  };
}
