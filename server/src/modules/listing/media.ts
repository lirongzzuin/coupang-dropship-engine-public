import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { AppContext } from '../../context.js';
import { errMessage } from '../../lib/util.js';
import { extractImageUrls } from './text.js';

export { extractImageUrls };

/**
 * 쿠팡 등록용 이미지 준비.
 * 공급처 이미지 URL은 확장자가 없거나(도매꾹 `…_img_760?hash=`) GIF·PNG인 경우가 많다.
 * 쿠팡은 이미지 URL(vendorPath)을 직접 내려받으므로 → 내려받아 JPEG로 변환 → 우리 /media/<id>.jpg 로 제공.
 * - 대표·추가 이미지: 흰 배경 정사각형(1000×1000, 최소 500 이상)
 * - 상세 이미지: 가로 최대 860, 비율 유지. 너무 작은 이미지(아이콘·구분선)는 제외
 * 공급처가 이미지 재사용을 허용한 상품에만 쓴다(호출 쪽에서 확인).
 */

const MAX_DOWNLOAD = 15 * 1024 * 1024;
/** 쿠팡 이미지 용량 제한(보수적) */
const MAX_JPEG = 3 * 1024 * 1024;
const MAIN_SIZE = 1000;
const DETAIL_WIDTH = 860;
/** 이보다 작은 상세 이미지는 아이콘·구분선으로 보고 제외 */
const MIN_DETAIL_SIDE = 200;
/** 상세 이미지 세로 최대(이보다 길면 잘라서 여러 장) */
const MAX_DETAIL_HEIGHT = 3000;
const MAX_DETAIL_IMAGES = 30;

export type ImageKind = 'main' | 'detail';

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/*,*/*' } });
  if (!res.ok) throw new Error(`이미지 다운로드 실패 ${res.status}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_DOWNLOAD) throw new Error('이미지가 너무 큼');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD) throw new Error('이미지가 너무 큼');
  return buf;
}

/** JPEG 인코딩(용량 초과 시 품질을 낮춰 재시도) */
async function toJpeg(img: sharp.Sharp): Promise<Buffer> {
  for (const quality of [90, 80, 70, 60]) {
    const out = await img.clone().jpeg({ quality, mozjpeg: true }).toBuffer();
    if (out.length <= MAX_JPEG) return out;
  }
  throw new Error('JPEG 변환 후에도 3MB 초과');
}

/** 원본 바이트 → JPEG 조각들(대표는 1장, 상세는 세로가 길면 여러 장) */
export async function convertImage(data: Buffer, kind: ImageKind): Promise<Buffer[]> {
  // GIF(움직이는 이미지)는 첫 프레임만, 투명 배경은 흰색으로
  const base = sharp(data, { animated: false, failOn: 'none' }).rotate();
  const meta = await base.metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h) throw new Error('이미지 형식을 읽을 수 없음');
  if (kind === 'main') {
    if (Math.max(w, h) < 300) throw new Error(`대표 이미지가 너무 작음(${w}×${h})`);
    const img = base.flatten({ background: '#ffffff' }).resize(MAIN_SIZE, MAIN_SIZE, { fit: 'contain', background: '#ffffff' });
    return [await toJpeg(img)];
  }
  // 아이콘(작은 정사각형)·구분선(얇은 띠)은 제외, 가로 배너(860×280 등)는 유지
  if (w < MIN_DETAIL_SIDE || h < 80 || (Math.max(w, h) < 400)) throw new Error('작은 이미지(아이콘·구분선) 제외');
  const width = Math.min(w, DETAIL_WIDTH);
  const resized = await base.flatten({ background: '#ffffff' }).resize({ width, withoutEnlargement: true }).toBuffer({ resolveWithObject: true });
  const H = resized.info.height;
  const parts: Buffer[] = [];
  // 긴 이미지는 같은 높이로 나눔(마지막 조각이 1px처럼 남지 않게)
  const n = Math.ceil(H / MAX_DETAIL_HEIGHT);
  const step = Math.ceil(H / n);
  for (let top = 0; top < H; top += step) {
    const height = Math.min(step, H - top);
    parts.push(await toJpeg(sharp(resized.data).extract({ left: 0, top, width: resized.info.width, height })));
  }
  return parts;
}

/**
 * URL 하나 → 우리 서버의 .jpg URL 목록. 이미 변환한 이미지는 다시 받지 않는다.
 * 실패하면 빈 배열(호출 쪽에서 건너뜀).
 */
export async function hostImage(ctx: AppContext, url: string, kind: ImageKind): Promise<string[]> {
  if (!/^https?:\/\//i.test(url)) return [];
  const id = createHash('sha1').update(`${kind}:${url}`).digest('hex').slice(0, 24);
  const first = `img-${id}.jpg`;
  if (await ctx.storage.get(first)) {
    const out = [ctx.storage.publicUrl(first)];
    for (let i = 1; ; i++) {
      const k = `img-${id}-${i}.jpg`;
      if (!(await ctx.storage.get(k))) break;
      out.push(ctx.storage.publicUrl(k));
    }
    return out;
  }
  try {
    const parts = await convertImage(await download(url), kind);
    const urls: string[] = [];
    for (const [i, buf] of parts.entries()) {
      const key = i === 0 ? first : `img-${id}-${i}.jpg`;
      urls.push(await ctx.storage.put(key, buf, 'image/jpeg'));
    }
    return urls;
  } catch (e) {
    ctx.log.warn({ url, err: errMessage(e) }, '이미지 변환 실패(건너뜀)');
    return [];
  }
}

/** 대표+추가 이미지(최대 10장) → .jpg URL. 대표가 실패하면 다음 이미지가 대표가 된다 */
export async function prepareMainImages(ctx: AppContext, urls: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const u of [...new Set(urls)]) {
    if (out.length >= 10) break;
    // 이미 우리 서버의 jpg(직접 업로드 등)는 그대로
    if (isOwnJpeg(ctx, u)) {
      out.push(u);
      continue;
    }
    out.push(...(await hostImage(ctx, u, 'main')).slice(0, 1));
  }
  return out;
}

/**
 * 공급처 상세 HTML의 이미지를 모두 .jpg로 바꿔 우리 서버 주소로 교체.
 * 변환에 실패한 이미지는 태그째 제거(쿠팡에서 깨진 이미지로 보이지 않게).
 */
export async function hostDetailHtml(ctx: AppContext, html: string): Promise<{ html: string; images: string[] }> {
  const map = new Map<string, string[]>();
  for (const u of extractImageUrls(html).slice(0, MAX_DETAIL_IMAGES)) map.set(u, await hostImage(ctx, u, 'detail'));
  const images: string[] = [];
  const out = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = tag.match(/\bsrc\s*=\s*["']?([^"'\s>]+)/i);
    let src = m?.[1]?.replace(/&amp;/g, '&') ?? '';
    if (src.startsWith('//')) src = `https:${src}`;
    const hosted = map.get(src);
    if (!hosted?.length) return '';
    images.push(...hosted);
    return hosted.map((u) => `<img src="${u}" style="max-width:100%;display:block;margin:0 auto" alt="">`).join('');
  });
  return { html: out, images };
}

function isOwnJpeg(ctx: AppContext, url: string): boolean {
  const base = ctx.storage.publicUrl('');
  return url.startsWith(base) && /\.jpe?g$/i.test(decodeURIComponent(url));
}
