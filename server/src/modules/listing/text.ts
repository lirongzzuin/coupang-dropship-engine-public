import { truncate } from '../../lib/util.js';

/** 상품명 정리: 금지 문구 제거, 특수문자·중복 공백 정리, 길이 제한 */
export function sanitizeTitle(raw: string, bannedTerms: string[], maxLen: number): string {
  let t = raw.replace(/<[^>]+>/g, ' ');
  // [무료배송] (당일발송) 같은 괄호 홍보문구 통째 제거
  t = t.replace(/[\[(【{]([^\])】}]*)[\])】}]/g, (m, inner: string) => (bannedTerms.some((b) => inner.replace(/\s/g, '').includes(b.replace(/\s/g, ''))) ? ' ' : m));
  for (const b of [...bannedTerms].sort((a, z) => z.length - a.length)) {
    if (!b) continue;
    t = t.replace(new RegExp(escapeRe(b).replace(/\\ /g, '\\s*'), 'gi'), ' ');
  }
  t = t.replace(/[^\p{L}\p{N}\s\-/(),.+&%xX×]/gu, ' ');
  t = t.replace(/\(\s*\)/g, ' ').replace(/\s+/g, ' ').trim();
  return truncate(t, maxLen).trim();
}

/** 금지 문구 검출(정리 후에도 남아 있으면 등록 차단) */
export function findBannedTerms(text: string, bannedTerms: string[]): string[] {
  const norm = text.replace(/\s+/g, '').toLowerCase();
  return bannedTerms.filter((b) => b && norm.includes(b.replace(/\s+/g, '').toLowerCase()));
}

/** 검색태그: 키워드 + 상품명 단어, 20자 이내·최대 N개·중복 제거 */
export function buildTags(title: string, keyword: string, bannedTerms: string[], max: number): string[] {
  const words = [keyword, ...title.split(/[\s,/()]+/)]
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, '').trim())
    .filter((w) => w.length >= 2 && [...w].length <= 20)
    .filter((w) => findBannedTerms(w, bannedTerms).length === 0);
  return [...new Set(words)].slice(0, max);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 상세페이지 HTML 생성.
 * - 공급처가 상세이미지 재사용을 허용(imageReuseAllowed)하고 상세 HTML이 있으면 그것을 포함
 * - 아니면 자체 템플릿(상품명·핵심정보·직접 업로드한 이미지)만 사용 — 타 판매자 콘텐츠 복제 금지
 */
export function buildDetailHtml(opts: {
  title: string;
  images: string[];
  facts: Array<{ name: string; value: string }>;
  sourceHtml?: string;
  reuseAllowed: boolean;
}): string {
  const facts = opts.facts.filter((f) => f.value).map((f) => `<tr><th style="text-align:left;padding:6px 12px;background:#f5f5f5">${escapeHtml(f.name)}</th><td style="padding:6px 12px">${escapeHtml(f.value)}</td></tr>`).join('');
  const imgs = opts.images.map((u) => `<img src="${escapeHtml(u)}" style="max-width:100%;display:block;margin:0 auto 12px" alt="">`).join('');
  const body = opts.reuseAllowed && opts.sourceHtml ? stripScripts(opts.sourceHtml) : imgs;
  return `<div style="max-width:860px;margin:0 auto;font-family:sans-serif">`
    + `<h2 style="text-align:center;font-size:22px;margin:24px 0">${escapeHtml(opts.title)}</h2>`
    + (facts ? `<table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:14px">${facts}</table>` : '')
    + body
    + `<p style="font-size:12px;color:#888;margin-top:24px">상품 정보 및 배송·교환·반품 안내는 쿠팡 정책을 따릅니다.</p></div>`;
}

function stripScripts(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<iframe[\s\S]*?<\/iframe>/gi, '').replace(/\son\w+="[^"]*"/gi, '');
}

/** 상세 HTML 안의 이미지 src 목록(중복 제거, 순서 유지) */
export function extractImageUrls(html: string): string[] {
  const urls = [...html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']?([^"'\s>]+)/gi)].map((m) => m[1]!.replace(/&amp;/g, '&'));
  return [...new Set(urls.map((u) => (u.startsWith('//') ? `https:${u}` : u)).filter((u) => /^https?:\/\//i.test(u)))];
}
