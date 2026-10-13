import type { Logger } from '../../lib/logger.js';
import { HttpError, RateLimiter, retry } from '../../lib/util.js';
import type { SourceAdapter, SourceCategory, SourceProductDetail, SourceProductSummary } from '../../ports/source.js';

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
        url: String(it.url ?? `https://domeggook.com/${it.no}`),
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

  async getProduct(no: string): Promise<SourceProductDetail | null> {
    const d = await this.call({ ver: '4.6', mode: 'getItemView', no });
    if (!d?.basis) return null;
    const unitPrice = parseTierPrice(this.market === 'supply' ? d.price?.supply ?? d.price?.dome : d.price?.dome);
    const deli = this.market === 'supply' ? (d.deli?.supply?.fee !== undefined ? d.deli.supply : d.deli?.dome) : d.deli?.dome;
    const free = String(d.deli?.pay ?? '').includes('무료') && !String(d.deli?.pay ?? '').includes('조건');
    // 수량별비례 "10+3000|10+3000" = 10개까지 한 상자 3,000원(fee 필드 없음) → 보수적으로 최소 수량·최대 금액
    const tiers = String(deli?.tbl ?? '').split('|').map((x) => x.split('+').map(Number)).filter((x) => x.length === 2 && x.every(Number.isFinite));
    const tblFee = tiers.length ? Math.max(...tiers.map((x) => x[1]!)) : 0;
    const perBox = tiers.length ? Math.max(1, Math.min(...tiers.map((x) => x[0]!))) : null;
    const statusText = String(d.basis.status ?? '');
    const stock = d.qty?.inventory !== undefined ? Number(d.qty.inventory) : null;
    const status: SourceProductDetail['status'] = statusText.includes('판매중') ? (stock === 0 ? 'soldout' : 'active') : 'ended';
    const sellerType = String(d.seller?.type ?? '');
    const kc = d.detail?.safetyCert;
    const images = [d.thumb?.original, d.thumb?.large].filter(Boolean) as string[];
    return {
      sourceItemId: String(no),
      title: String(d.basis.title ?? ''),
      url: `https://domeggook.com/${no}`,
      imageUrl: images[0],
      price: unitPrice,
      shippingFee: free ? 0 : Number(deli?.fee) || tblFee,
      status,
      stock,
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
