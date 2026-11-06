import { isLive } from '../../config/env.js';
import type { AppContext } from '../../context.js';
import { errMessage } from '../../lib/util.js';
import { vendorItemIds } from '../listing/items.js';

/**
 * 스마트스토어 판매상태 대조(쿠팡 판매상태 대조와 같은 역할, 60분마다 monitor 작업에서):
 * - 스마트스토어센터에서 삭제 → 판매종료(스마트스토어에서 삭제됨, 다시 등록 안 함)
 * - 네이버가 판매금지(PROHIBITION) → 일시중지 + 알림(자동 재개 안 함)
 * - 스마트스토어센터에서 판매중지(우리는 판매중으로 알고 있음) → 일시중지 기록(자동 재개 안 함)
 * - 우리가 멈춘 상품이 판매중으로 보임 → 다시 판매중지(품절·주문 불가 상품 주문 차단)
 */
export const NAVER_PAUSE = {
  deleted: '스마트스토어에서 삭제됨',
  prohibited: '스마트스토어 판매금지',
  stopped: '스마트스토어에서 판매중지됨',
} as const;

export async function reconcileNaver(ctx: AppContext): Promise<{ checked: number; deleted: number; stopped: number; restopped: number; errors: number }> {
  const out = { checked: 0, deleted: 0, stopped: 0, restopped: 0, errors: 0 };
  const s = await ctx.settings.get();
  const naver = ctx.markets?.naver;
  if (!naver || !s.naver.enabled || s.killSwitch) return out;
  let q = ctx.db.selectFrom('listings').selectAll().where('market', '=', 'naver').where('status', 'in', ['active', 'paused']).where('seller_product_id', 'is not', null);
  if (isLive(ctx.env, 'LIVE_LISTING')) q = q.where('dry_run', '=', false);
  const lines: string[] = [];
  for (const l of await q.execute()) {
    out.checked++;
    try {
      const st = await naver.getProductStatus(l.seller_product_id!);
      const now = ctx.clock.now();
      if (st.rawStatus === '상품삭제' || st.rawStatus === 'DELETE') {
        await ctx.db.updateTable('listings').set({ status: 'stopped', status_reason: NAVER_PAUSE.deleted, paused_at: null, updated_at: now }).where('id', '=', l.id).execute();
        out.deleted++;
        lines.push(`• 삭제됨: ${l.title.slice(0, 28)}`);
      } else if (st.rawStatus === 'PROHIBITION' && !l.status_reason?.startsWith(NAVER_PAUSE.prohibited)) {
        await ctx.db.updateTable('listings').set({ status: 'paused', status_reason: `${NAVER_PAUSE.prohibited} — 스마트스토어센터에서 사유 확인`, paused_at: l.paused_at ?? now, updated_at: now }).where('id', '=', l.id).execute();
        out.stopped++;
        lines.push(`• 판매금지: ${l.title.slice(0, 28)}`);
      } else if (st.rawStatus === 'SUSPENSION' && l.status === 'active') {
        await ctx.db.updateTable('listings').set({ status: 'paused', status_reason: `${NAVER_PAUSE.stopped}(스마트스토어센터) — 확인 후 [판매재개]`, paused_at: now, updated_at: now }).where('id', '=', l.id).execute();
        out.stopped++;
        lines.push(`• 판매중지됨: ${l.title.slice(0, 28)}`);
      } else if (st.rawStatus === 'SALE' && l.status === 'paused' && !l.status_reason?.startsWith(NAVER_PAUSE.stopped)) {
        // 우리가 멈춘 상품인데 판매중 → 옵션을 다시 멈춤
        let ok = true;
        for (const vid of await vendorItemIds(ctx, l)) {
          const state = await naver.getItemSaleState?.(vid);
          if (state?.onSale) ok = (await naver.stopSale(vid)).ok && ok;
        }
        if (ok) out.restopped++;
      }
    } catch (e) {
      out.errors++;
      ctx.log.warn({ listing: l.id, err: errMessage(e) }, '스마트스토어 판매상태 조회 실패');
    }
  }
  if (lines.length) {
    await ctx.notifications.notify('warn', `스마트스토어 판매상태 변경 ${lines.length}개`, `${lines.slice(0, 10).join('\n')}\n삭제된 상품은 판매종료로 정리했고, 판매금지·판매중지 상품은 자동으로 재개하지 않습니다(스마트스토어센터에서 사유 확인).`, { path: '/listings', push: false });
  }
  return out;
}
