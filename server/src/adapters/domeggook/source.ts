import type { Logger } from '../../lib/logger.js';
import { HttpError, RateLimiter, retry } from '../../lib/util.js';
import type { SourceAdapter, SourceCategory, SourceOption, SourceProductDetail, SourceProductSummary } from '../../ports/source.js';
import { resolveOption } from '../options.js';

/**
 * 도매꾹/도매매 Open API (API 키만 있으면 사용, 별도 승인 불필요).
 * 출처: https://openapi.domeggook.com/ko/articles/상품리스트-43780628 (getItemList v4.1),
 *       https://openapi.domeggook.com/ko/articles/상품상세정보-933abc24 (getItemView v4.6) — 확인 2026-10-13
 * 발주(setOrder)는 Private API 승인이 필요해 기본은 구매대행 작업함(assisted)으로 처리한다.
 * market: supply = 도매매(위탁·배송대행 전용), dome = 도매꾹
 */
export interface DomeggookOptions {
  apiKey: string;
  market?: 'supply' | 'dome';
  logger: Logger;
  fetchImpl?: typeof fetch;
}

const BASE = 'https://www.domeggook.com/ssl/api/';

export class DomeggookSource implements SourceAdapter {
  readonly id = 'domeggook';
  readonly displayName = '도매꾹/도매매';
  readonly capabilities = { search: true, detail: true, apiOrder: false, apiTracking: false };
  private readonly limiter = new RateLimiter(2);
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: DomeggookOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private get market(): 'supply' | 'dome' {
    return this.opts.market ?? 'supply';
  }

  /**
   * 사람이 구매할 상품 페이지. 도매매(supply)는 배송대행(고객 주소로 낱개 발송)·공급가 기준이라 도매매 페이지로 보낸다
   * (도매꾹 페이지는 최소구매수량·가격이 달라 잘못 사기 쉬움 — 실측 2026-10-14: 60000001 도매꾹 최소 2개·3,000원, 도매매 3,030원)
   */
  private itemUrl(no: string): string {
    return this.market === 'supply' ? `https://domeme.domeggook.com/s/${no}` : `https://domeggook.com/${no}`;
  }

  private async call(params: Record<string, string | number>): Promise<any> {
    const qs = new URLSearchParams({ aid: this.opts.apiKey, om: 'json', ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
    return retry(
      async () => {
        await this.limiter.take();
        const res = await this.fetchImpl(`${BASE}?${qs}`, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new HttpError(res.status, `도매꾹 API ${res.status}`);
        const json: any = await res.json();
        if (json?.errors || json?.domeggook?.errors) throw new HttpError(400, `도매꾹 API 오류: ${JSON.stringify(json.errors ?? json.domeggook.errors).slice(0, 200)}`);
        return json?.domeggook ?? json;
      },
      { attempts: 3, retryable: (e) => e instanceof HttpError && e.status >= 500 },
    );
  }

  async search(keyword: string, opts: { limit?: number; minPrice?: number; maxPrice?: number } = {}): Promise<SourceProductSummary[]> {
    const p: Record<string, string | number> = { ver: '4.1', mode: 'getItemList', market: this.market, kw: keyword, sz: Math.min(200, opts.limit ?? 20), pg: 1, so: 'se', org: 'kr' };
    if (opts.minPrice) p.mnp = opts.minPrice;
    if (opts.maxPrice) p.mxp = opts.maxPrice;
    const d = await this.call(p);
    const raw = d?.list?.item ?? [];
    const items: any[] = Array.isArray(raw) ? raw : [raw];
    return items
      .filter((it) => it && !toBool(it.adultOnly) && !toBool(it.deli?.fromOversea))
      .map((it) => ({
        sourceItemId: String(it.no),
        title: String(it.title ?? ''),
        url: this.itemUrl(String(it.no)),
        imageUrl: it.thumb ? String(it.thumb) : undefined,
        price: Number(it.price) || 0,
        shippingFee: it.deli?.who === 'S' ? 0 : Number(it.deli?.fee) || 0,
      }));
  }

  /** 카테고리 트리(getCategoryList v1.0) → 평탄화. 출처: openapi.domeggook.com 카테고리 목록(확인 2026-10-13) */
  async listCategories(): Promise<SourceCategory[]> {
    const d = await this.call({ ver: '1.0', mode: 'getCategoryList' });
    const out: SourceCategory[] = [];
    const walk = (node: any, parents: string[]) => {
      const children = node?.child ? Object.values(node.child) : [];
      const path = [...parents, String(node.name)];
      out.push({ code: String(node.code), name: String(node.name), path: path.join('>'), leaf: children.length === 0 });
      for (const ch of children) walk(ch, path);
    };
    for (const top of Object.values(d?.items ?? {})) walk(top, []);
    return out;
  }

  /** 카테고리 인기순(so=ha) 상품. 대분류만(01_00_00_00_00)은 조회 불가 → 2단계 이상 코드 */
  async popularItems(categoryCode: string, limit: number): Promise<SourceProductSummary[]> {
    const d = await this.call({ ver: '4.1', mode: 'getItemList', market: this.market, ca: categoryCode, sz: Math.min(200, limit), pg: 1, so: 'ha', org: 'kr' });
    const raw = d?.list?.item ?? [];
    const items: any[] = Array.isArray(raw) ? raw : [raw];
    return items.filter((it) => it && !toBool(it.adultOnly)).map((it) => ({
      sourceItemId: String(it.no), title: String(it.title ?? ''), url: String(it.url ?? ''), imageUrl: it.thumb ? String(it.thumb) : undefined,
      price: Number(it.price) || 0, shippingFee: it.deli?.who === 'S' ? 0 : Number(it.deli?.fee) || 0,
    }));
  }

  async getProduct(no: string, hint: { option?: string } = {}): Promise<SourceProductDetail | null> {
    const d = await this.call({ ver: '4.6', mode: 'getItemView', no });
    if (!d?.basis) return null;
    const unitPrice = parseTierPrice(this.market === 'supply' ? d.price?.supply ?? d.price?.dome : d.price?.dome);
    // 주문옵션(selectOpt): 옵션별 추가금·재고·판매 여부. 옵션 상품은 옵션 하나를 정해 그 가격·재고로 판매하고 그 옵션으로 구매
    // 이미 쿠팡에 올린 옵션(hint.option)이 있으면 그 옵션만 본다(품절이라고 다른 색·사이즈로 바꾸지 않음)
    const parsed = parseDomeggookOptions(d.selectOpt, this.market, unitPrice);
    const { chosen, pinMissing } = resolveOption(parsed.options, hint.option, 1);
    const deli = this.market === 'supply' ? (d.deli?.supply?.fee !== undefined || d.deli?.supply?.tbl ? d.deli.supply : d.deli?.dome) : d.deli?.dome;
    const free = String(d.deli?.pay ?? '').includes('무료') && !String(d.deli?.pay ?? '').includes('조건');
    // 수량별비례 "10+3000|10+3000" = 10개까지 한 상자 3,000원(fee 필드 없음) → 보수적으로 최소 수량·최대 금액
    const tiers = String(deli?.tbl ?? '').split('|').map((x) => x.split('+').map(Number)).filter((x) => x.length === 2 && x.every(Number.isFinite));
    const tblFee = tiers.length ? Math.max(...tiers.map((x) => x[1]!)) : 0;
    const perBox = tiers.length ? Math.max(1, Math.min(...tiers.map((x) => x[0]!))) : null;
    const statusText = String(d.basis.status ?? '');
    const total = d.qty?.inventory !== undefined ? Number(d.qty.inventory) : null;
    const stock = pinMissing ? 0 : chosen ? chosen.stock : total;
    let status: SourceProductDetail['status'] = statusText.includes('판매중') ? (stock === 0 ? 'soldout' : 'active') : 'ended';
    if (pinMissing) status = 'ended'; // 올린 옵션 자체가 없어짐
    const unavailableReason = pinMissing ? `판매 옵션(${hint.option})이 공급처에서 없어짐`
      : !statusText.includes('판매중') ? `공급처 판매 상태: ${statusText || '알 수 없음'}`
        : stock === 0 ? (chosen ? `옵션(${chosen.name}) 품절` : '공급처 품절') : undefined;
    const sellerType = String(d.seller?.type ?? '');
    const kc = d.detail?.safetyCert;
    // original(760)과 large(330)는 같은 사진의 크기만 다름 → 큰 것 하나만
    const images = [d.thumb?.original ?? d.thumb?.large].filter(Boolean) as string[];
    return {
      sourceItemId: String(no),
      title: String(d.basis.title ?? ''),
      url: this.itemUrl(no),
      imageUrl: images[0],
      price: chosen ? chosen.price : unitPrice,
      shippingFee: free ? 0 : Number(deli?.fee) || tblFee,
      status,
      stock,
      ...(status !== 'active' && unavailableReason ? { unavailableReason } : {}),
      ...(parsed.options.length ? { options: parsed.options } : {}),
      ...(chosen ? { defaultOption: chosen.name } : pinMissing ? { defaultOption: hint.option } : {}),
      ...(parsed.issue ? { optionIssue: parsed.issue } : {}),
      categoryPath: (d.category?.parents?.elem ?? []).concat(d.category?.current ? [d.category.current] : []).map((c: any) => c.name).join('>') || undefined,
      minResalePrice: Number(d.price?.resale?.minumum) || undefined,
      imageReuseAllowed: toBool(d.desc?.license?.usable),
      detailHtml: d.desc?.contents?.item ? String(d.desc.contents.item) : undefined,
      images,
      // 일반과세자·법인만 세금계산서 → 매입세액 공제
      taxInvoice: sellerType.includes('일반과세') || sellerType.includes('법인'),
      prepDays: Number.isFinite(parseFloat(d.deli?.periodDeli)) ? parseFloat(d.deli.periodDeli) : undefined,
      notice: d.detail?.infoDuty
        ? { type: d.detail.infoDuty.type, items: toArray(d.detail.infoDuty.item).map((x: any) => ({ name: String(x.name ?? ''), value: String(x.desc ?? '') })) }
        : undefined,
      kc: kc ? { certified: kc.cert === 'Y' || kc.useNo === 'Y', exempt: kc.exem === 'Y', certNo: kc.no || undefined, certType: kc.certType || undefined } : undefined,
      manufacturer: d.detail?.manufacturer || undefined,
      origin: d.detail?.country || undefined,
      sellerReviews: Number(d.seller?.score?.cnt) || 0,
      sellerScore: Number.isFinite(Number.parseFloat(String(d.seller?.score?.avg))) ? Number.parseFloat(String(d.seller.score.avg)) : undefined,
      // 도매매(supply)는 낱개 위탁 판매 단위(supplyUnit), 도매꾹은 최소구매수량(domeMoq)
      minOrderQty: this.market === 'supply' ? Number(d.qty?.supplyUnit ?? 1) || 1 : Number(d.qty?.domeMoq ?? 1) || 1,
      // 수량별 배송비 구간(tbl)이 있거나 묶음배송 불가면 배송비가 수량만큼 든다고 본다
      shippingPerUnit: !free && (String(d.deli?.merge?.enable ?? 'y').toLowerCase() === 'n' || perBox === 1),
      maxPerBox: free ? null : perBox,
    };
  }
}

/**
 * 도매꾹 주문옵션(selectOpt, JSON 문자열) → 옵션 목록. 형식은 실제 응답으로 확인(2026-10-14, 공식 문서는 첨부 문서만 있음):
 * - type 'combination': data 의 키 = 축별 옵션 순번("00", 두 축이면 "00_01"), name = 값(두 축이면 "핑크/5호")
 * - type 'independent': 축마다 따로 고름, 키 = "축순번_옵션순번", name = "축이름/값" → 축이 하나일 때만 지원
 * - supPrice(도매매)·domPrice(도매꾹) = 기본가에 더하는 추가금, qty = 옵션 재고
 * - hid ≠ '0' = 숨김·품절, sup/dom = 해당 시장 판매 여부('1') → 아니면 재고 0
 */
export function parseDomeggookOptions(selectOpt: unknown, market: 'supply' | 'dome', basePrice: number): { options: SourceOption[]; issue?: string } {
  let o: any = selectOpt;
  if (typeof o === 'string') {
    try {
      o = JSON.parse(o);
    } catch {
      return { options: [], issue: '도매꾹 옵션 정보를 해석하지 못함' };
    }
  }
  if (!o || typeof o !== 'object' || !o.data || typeof o.data !== 'object') return { options: [] };
  const sets: Array<{ name?: string; opts?: string[] }> = Array.isArray(o.set) ? o.set : Array.isArray(o.orgSet) ? o.orgSet : [];
  if (o.type === 'independent' && sets.length > 1) return { options: [], issue: '도매꾹 독립형 옵션이 여러 개(축마다 따로 고르는 옵션) — 쿠팡 옵션 하나로 정확히 표현할 수 없음' };
  const options: SourceOption[] = [];
  for (const [key, v] of Object.entries<any>(o.data)) {
    const idx = key.split('_').map((x) => Number(x));
    let attrs: Array<{ name: string; value: string }>;
    let name: string;
    if (o.type === 'independent') {
      const set = sets[idx[0] ?? 0];
      const value = String(set?.opts?.[idx[1] ?? 0] ?? String(v?.name ?? '').replace(/^[^/]*\//, ''));
      attrs = [{ name: String(set?.name ?? '옵션'), value }];
      name = value;
    } else if (sets.length > 1 && idx.length === sets.length) {
      attrs = sets.map((s, i) => ({ name: String(s.name ?? '옵션'), value: String(s.opts?.[idx[i]!] ?? '') })).filter((a) => a.value);
      name = String(v?.name ?? attrs.map((a) => a.value).join('/'));
    } else {
      name = String(v?.name ?? '');
      attrs = name ? [{ name: String(sets[0]?.name ?? '옵션'), value: name }] : [];
    }
    if (!name) continue;
    const sold = String(market === 'supply' ? v?.sup ?? '1' : v?.dom ?? '1') === '1';
    const visible = String(v?.hid ?? '0') === '0';
    const qty = Number(v?.qty);
    const extra = Number(market === 'supply' ? v?.supPrice ?? v?.domPrice : v?.domPrice) || 0;
    options.push({ name, price: Math.round(basePrice + extra), stock: sold && visible ? (Number.isFinite(qty) ? qty : null) : 0, attrs });
  }
  return { options };
}

/** "1+3800|20+3500" 수량별 단가 → 1개 기준 단가. 정수면 그대로 */
export function parseTierPrice(v: unknown): number {
  if (typeof v === 'number') return v;
  const s = String(v ?? '');
  if (/^\d+$/.test(s)) return Number(s);
  const first = s.split('|')[0] ?? '';
  const m = first.match(/\+(\d+)/);
  return m ? Number(m[1]) : 0;
}

function toBool(v: unknown): boolean {
  return v === true || v === 'true' || v === 'Y' || v === 1 || v === '1';
}
function toArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}
