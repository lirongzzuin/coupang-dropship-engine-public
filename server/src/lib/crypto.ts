import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// ── 개인정보 컬럼 암호화 (AES-256-GCM) ──────────────────────────────

export class PiiCipher {
  private readonly key: Buffer;
  constructor(keyMaterial: string) {
    let key: Buffer;
    if (/^[0-9a-fA-F]{64}$/.test(keyMaterial)) key = Buffer.from(keyMaterial, 'hex');
    else {
      const b = Buffer.from(keyMaterial, 'base64');
      key = b.length === 32 ? b : createHash('sha256').update(keyMaterial).digest();
    }
    this.key = key;
  }

  encrypt(plain: string | null | undefined): string | null {
    if (plain === null || plain === undefined || plain === '') return null;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
  }

  decrypt(token: string | null | undefined): string | null {
    if (!token) return null;
    const [ver, ivB, tagB, encB] = token.split(':');
    if (ver !== 'v1' || !ivB || !tagB || encB === undefined) throw new Error('PII 토큰 형식 오류');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(encB, 'base64')), decipher.final()]).toString('utf8');
  }
}

/** 주소 변경 감지용 해시(복호화 없이 비교) */
export function hashAddress(parts: Array<string | null | undefined>): string {
  return createHash('sha256').update(parts.map((p) => (p ?? '').trim()).join('|')).digest('hex').slice(0, 32);
}

// ── 비밀번호 (scrypt) ───────────────────────────────────────────────

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, saltB, hashB] = stored.split(':');
  if (alg !== 'scrypt' || !saltB || !hashB) return false;
  const expected = Buffer.from(hashB, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}

// ── TOTP (RFC 6238, SHA1, 30초, 6자리) ──────────────────────────────

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const idx = B32.indexOf(c);
    if (idx < 0) throw new Error('base32 형식 오류');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpAt(secret: string, timeMs: number, step = 30, digits = 6): string {
  const counter = Math.floor(timeMs / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = h[h.length - 1]! & 0xf;
  const code = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(code % 10 ** digits).padStart(digits, '0');
}

/** 앞뒤 1스텝(±30초) 허용 */
export function verifyTotp(secret: string, code: string, nowMs = Date.now()): boolean {
  const c = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  for (const d of [-1, 0, 1]) {
    if (totpAt(secret, nowMs + d * 30_000) === c) return true;
  }
  return false;
}

export function totpUri(secret: string, account: string, issuer = 'CoupangDropship'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;
}

export function randomId(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}
