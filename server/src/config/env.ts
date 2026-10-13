import { z } from 'zod';

/**
 * 비밀값·인프라·안전 플래그. 사업 파라미터(수수료율·마진 등)는 여기에 두지 않고
 * settings(DB)에 둔다 → 관리자 웹에서 수정 가능.
 */
const bool = (def: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => (v === undefined ? def : typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const optStr = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default('0.0.0.0'),
  /** 외부에서 접근하는 주소. 텔레그램 링크·이미지 공개 URL 생성에 사용 */
  PUBLIC_BASE_URL: z.string().default('http://localhost:8080'),

  /** postgres://... 가 있으면 PostgreSQL, 없으면 PGlite(DATA_DIR/pglite) */
  DATABASE_URL: optStr,
  DATA_DIR: z.string().default('./data'),

  /** 32바이트 키(hex 64자 또는 base64). 고객 개인정보 컬럼 암호화 */
  PII_KEY: z.string().min(32),
  /** 세션 쿠키 서명 */
  SESSION_SECRET: z.string().min(16),

  // ── 안전 플래그: 기본은 전부 모의 실행 ──
  DRY_RUN: bool(true),
  LIVE_LISTING: bool(false),
  LIVE_PRICING: bool(false),
  LIVE_FULFILLMENT: bool(false),
  LIVE_ORDERING: bool(false),
  LIVE_CS: bool(false),

  /** coupang | fake. fake는 키 없이 전체 흐름을 체험·테스트하는 내장 가짜 쿠팡 */
  MARKET_ADAPTER: z.enum(['coupang', 'fake']).default('fake'),
  COUPANG_BASE_URL: z.string().default('https://api-gateway.coupang.com'),
  COUPANG_VENDOR_ID: optStr,
  COUPANG_ACCESS_KEY: optStr,
  COUPANG_SECRET_KEY: optStr,

  DOMEGGOOK_API_KEY: optStr,
  /** supply=도매매(위탁 전용, 기본) | dome=도매꾹 */
  DOMEGGOOK_MARKET: z.enum(['supply', 'dome']).default('supply'),
  /** 오너클랜 판매사 계정(API 자동 발주용) */
  OWNERCLAN_USERNAME: optStr,
  OWNERCLAN_PASSWORD: optStr,
  OWNERCLAN_SANDBOX: bool(false),
  NAVER_CLIENT_ID: optStr,
  NAVER_CLIENT_SECRET: optStr,
  NAVER_SEARCHAD_CUSTOMER_ID: optStr,
  NAVER_SEARCHAD_API_KEY: optStr,
  NAVER_SEARCHAD_SECRET: optStr,

  TELEGRAM_BOT_TOKEN: optStr,
  TELEGRAM_CHAT_ID: optStr,

  /** 공인 IP 변경 감시(집 PC 운영 시 필수). 쿠팡 허용 IP 갱신 알림 */
  PUBLIC_IP_CHECK: bool(true),
  /** 내장 스케줄러 실행 여부(테스트·일회성 CLI에서는 false) */
  SCHEDULER_ENABLED: bool(true),
  /** mock 공급처를 소스 목록에 노출(데모/테스트) */
  ENABLE_MOCK_SOURCE: bool(false),
  /** 체험 모드: 가짜 쿠팡 + 가짜 공급처·시장데이터 + 데모 주문 생성 버튼 (MARKET_ADAPTER=fake 일 때만) */
  DEMO_MODE: bool(false),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`환경변수 오류:\n${msg}`);
  }
  const env = parsed.data;
  if (env.MARKET_ADAPTER === 'coupang' && (!env.COUPANG_VENDOR_ID || !env.COUPANG_ACCESS_KEY || !env.COUPANG_SECRET_KEY)) {
    throw new Error('MARKET_ADAPTER=coupang 이면 COUPANG_VENDOR_ID / COUPANG_ACCESS_KEY / COUPANG_SECRET_KEY 가 필요합니다.');
  }
  return env;
}

/** 실제 외부 부작용을 허용하는지. DRY_RUN=true면 모든 기능 플래그보다 우선해 차단 */
export type LiveFeature = 'LIVE_LISTING' | 'LIVE_PRICING' | 'LIVE_FULFILLMENT' | 'LIVE_ORDERING' | 'LIVE_CS';
export function isLive(env: Env, feature: LiveFeature): boolean {
  return !env.DRY_RUN && env[feature] === true;
}
