import pino from 'pino';

/** 비밀값·개인정보가 로그에 남지 않도록 경로 기반 마스킹 */
const REDACT = [
  '*.secret', '*.secretKey', '*.password', '*.passwordHash', '*.token', '*.authorization', '*.Authorization',
  '*.receiver', '*.orderer', '*.receiverName', '*.receiverPhone', '*.receiverAddr', '*.addr1', '*.addr2',
  '*.safeNumber', '*.phone', 'headers.authorization', 'req.headers.cookie', 'req.headers.authorization',
];

export type Logger = pino.Logger;

export function createLogger(level: string = 'info'): Logger {
  return pino({ level, redact: { paths: REDACT, censor: '[MASKED]' } });
}

export function maskName(name: string | null | undefined): string {
  if (!name) return '';
  if (name.length <= 1) return '*';
  return name[0] + '*'.repeat(Math.max(1, name.length - 2)) + (name.length > 2 ? name[name.length - 1] : '');
}

export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return '***';
  return `${digits.slice(0, 3)}-****-${digits.slice(-4)}`;
}

export function maskAddress(addr: string | null | undefined): string {
  if (!addr) return '';
  const parts = addr.split(/\s+/);
  return parts.slice(0, 2).join(' ') + (parts.length > 2 ? ' ***' : '');
}
