import { createHmac } from 'node:crypto';

/**
 * 쿠팡 OPEN API HMAC 서명.
 * 출처: https://developers.coupang.com/ko/getting-started/creating-hmac-signature (확인 2026-10-13)
 *  message = signedDate(yyMMdd'T'HHmmss'Z', UTC) + method + path + query(물음표 제외)
 *  signature = hex(HMAC-SHA256(secret, message))
 *  Authorization: CEA algorithm=HmacSHA256, access-key=..., signed-date=..., signature=...
 */
export function signedDate(now: Date): string {
  const iso = now.toISOString(); // 2026-10-13T06:31:54.806Z
  return `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

export function buildAuthorization(opts: {
  method: string;
  path: string;
  query: string;
  accessKey: string;
  secretKey: string;
  now?: Date;
}): string {
  const dt = signedDate(opts.now ?? new Date());
  const message = dt + opts.method.toUpperCase() + opts.path + opts.query;
  const signature = createHmac('sha256', opts.secretKey).update(message, 'utf8').digest('hex');
  return `CEA algorithm=HmacSHA256, access-key=${opts.accessKey}, signed-date=${dt}, signature=${signature}`;
}
