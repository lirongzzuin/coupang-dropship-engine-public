import { buildContext } from '../app.js';
import { loadEnv } from '../config/env.js';
import { totpUri } from '../lib/crypto.js';
import { AuthService } from '../http/auth.js';

/**
 * 관리자 계정 생성/재설정:  pnpm --filter server admin:create <아이디> <비밀번호>
 * 출력된 TOTP 비밀키(또는 otpauth URI)를 Google Authenticator 등에 등록한다.
 */
async function main(): Promise<void> {
  const [username, password] = process.argv.slice(2);
  if (!username || !password) {
    console.error('사용법: admin:create <아이디> <비밀번호(10자 이상)>');
    process.exit(1);
  }
  const ctx = await buildContext({ ...loadEnv(), SCHEDULER_ENABLED: false });
  const { totpSecret } = await new AuthService(ctx).createAdmin(username, password);
  console.log(`관리자 "${username}" 생성 완료`);
  console.log(`OTP 비밀키: ${totpSecret}`);
  console.log(`OTP 등록 URI: ${totpUri(totpSecret, username)}`);
  await ctx.db.destroy();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
