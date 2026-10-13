import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { convertImage, hostDetailHtml, prepareMainImages } from '../src/modules/listing/media.js';
import { extractImageUrls } from '../src/modules/listing/text.js';
import { makeHarness, type TestHarness } from './helpers.js';

const isJpeg = (b: Buffer) => b[0] === 0xff && b[1] === 0xd8;
const solid = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 4, background: { r: 200, g: 50, b: 50, alpha: 0.5 } } });

let server: Server;
let base = '';
const files: Record<string, { type: string; data: Buffer }> = {};

beforeAll(async () => {
  files['/item_img_760'] = { type: 'application/octet-stream', data: await solid(760, 760).jpeg().toBuffer() }; // 도매꾹처럼 확장자 없음
  files['/detail_01.gif'] = { type: 'image/gif', data: await solid(860, 1200).gif().toBuffer() };
  files['/detail_02.png'] = { type: 'image/png', data: await solid(1200, 7000).png().toBuffer() }; // 아주 긴 상세
  files['/icon.png'] = { type: 'image/png', data: await solid(40, 40).png().toBuffer() };
  files['/broken.jpg'] = { type: 'image/jpeg', data: Buffer.from('not an image') };
  server = createServer((req, res) => {
    const f = files[req.url!.split('?')[0]!];
    if (!f) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': f.type }).end(f.data);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

let h: TestHarness;
afterEach(async () => h && (await h.close()));

describe('이미지 변환(.jpg)', () => {
  it('대표: 확장자 없는 이미지·투명 PNG → 흰 배경 1000×1000 JPEG', async () => {
    const [out] = await convertImage(files['/item_img_760']!.data, 'main');
    expect(isJpeg(out!)).toBe(true);
    const m = await sharp(out!).metadata();
    expect([m.width, m.height]).toEqual([1000, 1000]);
    const [png] = await convertImage(await solid(600, 300).png().toBuffer(), 'main');
    const px = await sharp(png!).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    expect([...px]).toEqual([255, 255, 255]); // 여백은 흰색
  });

  it('상세: GIF → JPEG, 가로 860 이하, 긴 이미지는 3000px 단위로 분할, 아이콘은 제외', async () => {
    const gif = await convertImage(files['/detail_01.gif']!.data, 'detail');
    expect(gif).toHaveLength(1);
    expect(isJpeg(gif[0]!)).toBe(true);
    const long = await convertImage(files['/detail_02.png']!.data, 'detail');
    expect(long.length).toBe(2); // 1200×7000 → 860×5017 → 2장
    for (const p of long) expect((await sharp(p).metadata()).height).toBeLessThanOrEqual(3000);
    await expect(convertImage(files['/icon.png']!.data, 'detail')).rejects.toThrow(/아이콘/);
    await expect(convertImage(await solid(860, 2).png().toBuffer(), 'detail')).rejects.toThrow(/구분선/); // 얇은 띠
    expect(await convertImage(await solid(860, 281).png().toBuffer(), 'detail')).toHaveLength(1); // 가로 배너는 유지
    const even = await convertImage(await solid(860, 6001).png().toBuffer(), 'detail'); // 3000+3000+1 이 아니라 3등분
    expect(even).toHaveLength(3);
    for (const p of even) expect((await sharp(p).metadata()).height).toBeGreaterThan(1900);
    await expect(convertImage(await solid(100, 100).png().toBuffer(), 'main')).rejects.toThrow(/작음/);
  });

  it('공급처 URL → 우리 서버 .jpg URL(캐시), 상세 HTML 이미지 교체·실패 이미지 제거', async () => {
    h = await makeHarness();
    const main = await prepareMainImages(h.ctx, [`${base}/item_img_760?hash=abc`, `${base}/broken.jpg`]);
    expect(main).toHaveLength(1);
    expect(main[0]).toMatch(/\/media\/img-[0-9a-f]+\.jpg$/);
    const key = decodeURIComponent(main[0]!.split('/media/')[1]!);
    const stored = (await h.ctx.storage.get(key))!;
    expect(stored.contentType).toBe('image/jpeg');
    expect(isJpeg(stored.data)).toBe(true);
    expect(await prepareMainImages(h.ctx, [`${base}/item_img_760?hash=abc`])).toEqual(main); // 다시 받지 않음

    const html = `<p>안내</p><img src="${base}/detail_01.gif"><img src='${base}/icon.png'><IMG SRC="${base}/detail_02.png" width=100><img src="${base}/missing.jpg">`;
    const r = await hostDetailHtml(h.ctx, html);
    expect(r.images).toHaveLength(3); // gif 1장 + 긴 png 2장
    expect(extractImageUrls(r.html).every((u) => /\/media\/img-[0-9a-f-]+\.jpg$/.test(u))).toBe(true);
    expect(r.html).not.toContain(base); // 원본 주소·아이콘·없는 이미지 모두 제거
    expect(r.html).toContain('<p>안내</p>');
  });

  it('상세 HTML 이미지 추출: 따옴표 없음·// 주소·&amp; 처리, 중복 제거', () => {
    expect(extractImageUrls('<img src=//a.com/1.jpg><img alt="x" src="https://a.com/2.jpg?a=1&amp;b=2"><img src="https://a.com/2.jpg?a=1&b=2"><img src="data:image/png;base64,xx">'))
      .toEqual(['https://a.com/1.jpg', 'https://a.com/2.jpg?a=1&b=2']);
  });
});
