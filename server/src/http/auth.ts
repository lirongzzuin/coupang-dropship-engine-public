import type { AppContext } from '../context.js';
import { audit } from '../context.js';
import { generateTotpSecret, hashPassword, randomId, verifyPassword, verifyTotp } from '../lib/crypto.js';

const SESSION_DAYS = 14;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

/** 단일 관리자 + TOTP 2단계 인증 */
export class AuthService {
  private fails = new Map<string, { n: number; until: number }>();
  constructor(private readonly ctx: AppContext) {}

  async createAdmin(username: string, password: string): Promise<{ totpSecret: string }> {
    if (password.length < 10) throw new Error('비밀번호는 10자 이상');
    const totpSecret = generateTotpSecret();
    await this.ctx.db
      .insertInto('admin_users')
      .values({ username, password_hash: hashPassword(password), totp_secret: totpSecret, created_at: this.ctx.clock.now() })
      .onConflict((oc) => oc.column('username').doUpdateSet({ password_hash: hashPassword(password), totp_secret: totpSecret }))
      .execute();
    return { totpSecret };
  }

  async hasAdmin(): Promise<boolean> {
    const r = await this.ctx.db.selectFrom('admin_users').select('id').executeTakeFirst();
    return !!r;
  }

  async login(username: string, password: string, totp: string, ip: string): Promise<string> {
    const key = `${ip}|${username}`;
    const f = this.fails.get(key);
    const now = Date.now();
    if (f && f.until > now) throw new AuthError(`로그인 시도 제한 — ${Math.ceil((f.until - now) / 60000)}분 후 다시 시도`);
    const u = await this.ctx.db.selectFrom('admin_users').selectAll().where('username', '=', username).executeTakeFirst();
    const ok = !!u && verifyPassword(password, u.password_hash) && verifyTotp(u.totp_secret, totp, this.ctx.clock.now().getTime());
    if (!ok || !u) {
      const n = (f?.n ?? 0) + 1;
      this.fails.set(key, { n, until: n >= MAX_FAILS ? now + LOCK_MINUTES * 60_000 : 0 });
      await audit(this.ctx, username || '-', 'auth.fail', ip);
      throw new AuthError('아이디/비밀번호/인증코드가 올바르지 않습니다');
    }
    this.fails.delete(key);
    const id = randomId();
    await this.ctx.db.insertInto('sessions').values({ id, user_id: u.id, expires_at: new Date(this.ctx.clock.now().getTime() + SESSION_DAYS * 86400_000), created_at: this.ctx.clock.now() }).execute();
    await audit(this.ctx, username, 'auth.login', ip);
    return id;
  }

  async session(id: string | undefined): Promise<{ username: string } | null> {
    if (!id) return null;
    const r = await this.ctx.db
      .selectFrom('sessions')
      .innerJoin('admin_users', 'admin_users.id', 'sessions.user_id')
      .select(['admin_users.username', 'sessions.expires_at'])
      .where('sessions.id', '=', id)
      .executeTakeFirst();
    if (!r || new Date(r.expires_at) < this.ctx.clock.now()) return null;
    return { username: r.username };
  }

  async logout(id: string | undefined): Promise<void> {
    if (id) await this.ctx.db.deleteFrom('sessions').where('id', '=', id).execute();
  }
}

export class AuthError extends Error {}
