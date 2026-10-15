import { afterEach, describe, expect, it } from 'vitest';
import { Scheduler } from '../src/jobs/scheduler.js';
import { makeHarness, type TestHarness } from './helpers.js';

/** 방해금지 시간(한국시간 23:00~07:00): 급한 알림만 바로, 나머지는 아침에 모아서 한 번에 */
let h: TestHarness;
afterEach(async () => h && (await h.close()));

/** KST 시각으로 하네스 만들기 */
async function at(kst: string) {
  h = await makeHarness({ start: new Date(`${kst}+09:00`) });
  await h.ctx.settings.update({ notify: { quietHours: { enabled: true } } });
}
const n = h0();
function h0() {
  return (level: 'info' | 'warn' | 'error' | 'action', title: string, body = '내용', opts = {}) => h.ctx.notifications.notify(level, title, body, opts);
}

describe('방해금지 시간', () => {
  it('경계: 22:59 보냄 · 23:00 보류 · 06:59 보류 · 07:00 보냄', async () => {
    await at('2026-10-15T22:59:00');
    expect(await h.ctx.notifications.isQuiet()).toBe(false);
    const q = (t: string) => h.ctx.notifications.isQuiet(new Date(`${t}+09:00`));
    expect(await q('2026-10-15T23:00:00')).toBe(true);
    expect(await q('2026-10-16T03:00:00')).toBe(true);
    expect(await q('2026-10-16T06:59:00')).toBe(true);
    expect(await q('2026-10-16T07:00:00')).toBe(false);
    expect(await q('2026-10-16T12:00:00')).toBe(false);
  });

  it('밤에는 일반 알림(새 주문·품절 주문·발주 실패 등) 보류, 급한 알림(판매 중지·주문 수집 중단·IP 변경·주문 작업 실패)은 바로', async () => {
    await at('2026-10-16T02:00:00');
    await n('info', '새 주문 — 자동 발주 완료', '독서노트 1개 — 오너클랜 주문 …');
    await n('action', '구매할 주문이 있어요');
    await n('error', '품절 주문 발생', '수납함 — 공급처 품절');
    await n('error', '품절 주문 발생', '노트 — 공급처 품절');
    await n('warn', '⚠️ 문제 감지');
    expect(h.notifier.sent).toHaveLength(0);
    await n('error', '🛑 자동 판매 중지', '안전장치');
    await n('error', '주문 수집이 멈췄습니다');
    await n('error', '공인 IP 변경: 1.1.1.1 → 2.2.2.2');
    await n('error', '작업 실패: 주문 수집·처리');
    await n('warn', '직접 지정한 급한 알림', '', { urgent: true });
    expect(h.notifier.titles()).toEqual(['🛑 자동 판매 중지', '주문 수집이 멈췄습니다', '공인 IP 변경: 1.1.1.1 → 2.2.2.2', '작업 실패: 주문 수집·처리', '직접 지정한 급한 알림']);
    // 보류한 알림도 관리 화면(알림 목록)에는 바로 보임
    const held = await h.ctx.db.selectFrom('notifications').selectAll().where('held', '=', true).execute();
    expect(held.map((r) => r.title)).toEqual(['새 주문 — 자동 발주 완료', '구매할 주문이 있어요', '품절 주문 발생', '품절 주문 발생', '⚠️ 문제 감지']);
    // 아직 밤이면 모아 보내기 안 함
    expect(await h.ctx.notifications.flushHeld()).toBe(0);
  });

  it('07:00에 밤사이 알림을 한 통으로(급한 순·제목별 건수), 다시 보내지 않음', async () => {
    await at('2026-10-16T01:00:00');
    await n('info', '새 주문 — 자동 발주 완료', '독서노트 1개 — 오너클랜 주문 2026…\n둘째 줄');
    await n('error', '품절 주문 발생', '수납함');
    await n('error', '품절 주문 발생', '노트');
    await n('action', '고객문의 1건 답변 필요');
    h.clock.advanceMinutes(6 * 60); // 07:00
    expect(await h.ctx.notifications.flushHeld()).toBe(4);
    expect(h.notifier.sent).toHaveLength(1);
    const d = h.notifier.sent[0]!;
    expect(d).toMatchObject({ level: 'error', title: '🌙 밤사이 알림 4건' });
    const lines = d.body.split('\n');
    expect(lines[0]).toBe('❗ 품절 주문 발생 ×2');
    expect(lines).toContain('👉 고객문의 1건 답변 필요 — 내용');
    expect(d.body).toContain('ℹ️ 새 주문 — 자동 발주 완료 — 독서노트 1개 — 오너클랜 주문 2026…');
    expect(d.body).not.toContain('둘째 줄');
    expect(await h.ctx.db.selectFrom('notifications').select('id').where('held', '=', true).execute()).toHaveLength(0);
    expect(await h.ctx.notifications.flushHeld()).toBe(0);
    expect(h.notifier.sent).toHaveLength(1);
    // 낮에는 바로 보냄
    await n('info', '상품 판매 시작');
    expect(h.notifier.titles()).toEqual(['🌙 밤사이 알림 4건', '상품 판매 시작']);
  });

  it('텔레그램 전송 실패면 보류 유지 → 다음 확인 때 다시', async () => {
    await at('2026-10-16T05:00:00');
    await n('info', '새 주문 — 자동 발주 완료');
    h.clock.advanceMinutes(150);
    const send = h.notifier.send.bind(h.notifier);
    h.notifier.send = async () => false;
    expect(await h.ctx.notifications.flushHeld()).toBe(0);
    expect(await h.ctx.db.selectFrom('notifications').select('id').where('held', '=', true).execute()).toHaveLength(1);
    h.notifier.send = send;
    expect(await h.ctx.notifications.flushHeld()).toBe(1);
  });

  it('스케줄러가 5분마다 확인해 아침에 보냄, 설정으로 끄거나 시간 변경', async () => {
    await at('2026-10-16T06:50:00');
    await n('info', '새 주문 — 자동 발주 완료');
    const sch = new Scheduler(h.ctx);
    expect(await sch.runJob('notify.digest')).toMatchObject({ ok: true, result: { sent: 0 } });
    h.clock.advanceMinutes(10);
    expect(await sch.runJob('notify.digest')).toMatchObject({ ok: true, result: { sent: 1 } });
    // 끄면 밤에도 바로
    await h.ctx.settings.update({ notify: { quietHours: { enabled: false } } });
    expect(await h.ctx.notifications.isQuiet(new Date('2026-10-16T02:00:00+09:00'))).toBe(false);
    // 22~06시로 변경
    await h.ctx.settings.update({ notify: { quietHours: { enabled: true, start: 22, end: 6 } } });
    expect(await h.ctx.notifications.isQuiet(new Date('2026-10-16T22:30:00+09:00'))).toBe(true);
    expect(await h.ctx.notifications.isQuiet(new Date('2026-10-17T06:30:00+09:00'))).toBe(false);
  });
});
