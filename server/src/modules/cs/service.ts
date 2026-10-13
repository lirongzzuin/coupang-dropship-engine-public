import { type AppContext, audit } from '../../context.js';
import { addDays } from '../../lib/util.js';

/**
 * 고객문의: 수집 → 템플릿 분류 → (자동) 정형 문의는 템플릿 답변, 나머지는 초안 + 알림.
 * 실제 답변 전송은 LIVE_CS 플래그(DryRunMarket)에서 통제.
 */
export function classify(content: string, templates: Array<{ name: string; keywords: string[]; reply: string }>) {
  const text = content.replace(/\s+/g, '');
  // 불만·환불·파손 등은 자동답변 금지(사람 확인)
  if (/(환불|파손|불량|고장|사기|신고|화나|최악|교환|반품|취소)/.test(text)) return null;
  return templates.find((t) => t.keywords.some((k) => text.includes(k))) ?? null;
}

export async function pollInquiries(ctx: AppContext): Promise<{ fetched: number; autoAnswered: number; drafted: number }> {
  const s = await ctx.settings.get();
  const now = ctx.clock.now();
  const list = await ctx.market.listInquiries(addDays(now, -6), now);
  let fetched = 0, autoAnswered = 0, drafted = 0;
  for (const q of list) {
    if (q.answered) continue;
    const ins = await ctx.db
      .insertInto('inquiries')
      .values({ market: ctx.market.name, market_inquiry_id: q.inquiryId, kind: q.kind, vendor_item_id: q.vendorItemId ?? null, content: q.content, asked_at: q.askedAt, status: 'new' })
      .onConflict((oc) => oc.columns(['market', 'kind', 'market_inquiry_id']).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (!ins) continue;
    fetched++;
    const tpl = classify(q.content, s.cs.templates);
    if (tpl && s.cs.autoReplyTemplates && !s.killSwitch) {
      const r = await ctx.market.replyInquiry({ inquiryId: q.inquiryId, kind: q.kind }, tpl.reply);
      if (r.ok) {
        await ctx.db.updateTable('inquiries').set({ status: 'answered', answer: tpl.reply, answered_at: now, dry_run: !!r.dryRun }).where('id', '=', ins.id).execute();
        autoAnswered++;
        continue;
      }
    }
    await ctx.db.updateTable('inquiries').set({ status: 'drafted', draft: tpl?.reply ?? '' }).where('id', '=', ins.id).execute();
    drafted++;
  }
  if (drafted) await ctx.notifications.notify('action', `고객문의 ${drafted}건 답변 필요`, '자동 답변하지 않은 문의가 있습니다(불만/환불/기타).', { path: '/inquiries' });
  return { fetched, autoAnswered, drafted };
}

export async function answerInquiry(ctx: AppContext, id: number, text: string, actor: string): Promise<void> {
  const q = await ctx.db.selectFrom('inquiries').selectAll().where('id', '=', id).executeTakeFirst();
  if (!q) throw new Error('문의 없음');
  if (q.status === 'answered') throw new Error('이미 답변한 문의입니다');
  if (!text.trim()) throw new Error('답변 내용을 입력하세요');
  const r = await ctx.market.replyInquiry({ inquiryId: q.market_inquiry_id, kind: q.kind as 'product' | 'callcenter' }, text.trim());
  if (!r.ok) throw new Error(`답변 실패: ${r.message}`);
  await ctx.db.updateTable('inquiries').set({ status: 'answered', answer: text.trim(), answered_at: ctx.clock.now(), dry_run: !!r.dryRun }).where('id', '=', id).execute();
  await audit(ctx, actor, 'inquiry.answer', String(id));
}
