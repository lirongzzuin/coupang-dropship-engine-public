import type { Logger } from '../../lib/logger.js';
import type { Notifier } from '../../ports/misc.js';

const ICON = { info: 'ℹ️', warn: '⚠️', error: '🚨', action: '🛒' } as const;

/** 텔레그램 봇 알림. 토큰이 없으면 로그만 남긴다(알림은 DB notifications 에도 항상 저장됨). */
export class TelegramNotifier implements Notifier {
  constructor(
    private readonly opts: { token?: string; chatId?: string; logger: Logger; fetchImpl?: typeof fetch },
  ) {}

  async send(msg: { level: 'info' | 'warn' | 'error' | 'action'; title: string; body: string; link?: string }): Promise<boolean> {
    if (!this.opts.token || !this.opts.chatId) {
      this.opts.logger.info({ title: msg.title }, '[notify] 텔레그램 미설정 — DB에만 기록');
      return false;
    }
    const text = `${ICON[msg.level]} <b>${escapeHtml(msg.title)}</b>\n${escapeHtml(msg.body)}${msg.link ? `\n<a href="${escapeHtml(msg.link)}">열기</a>` : ''}`;
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(`https://api.telegram.org/bot${this.opts.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.opts.chatId, text: text.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) this.opts.logger.warn({ status: res.status }, 'telegram send failed');
      return res.ok;
    } catch (e) {
      this.opts.logger.warn({ err: String(e) }, 'telegram send error');
      return false;
    }
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
