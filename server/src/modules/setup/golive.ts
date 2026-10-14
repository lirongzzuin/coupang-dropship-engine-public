import type { AppContext } from '../../context.js';
import { errMessage } from '../../lib/util.js';

export interface ReadinessItem {
  name: string;
  ok: boolean;
  /** true면 실전 전환을 막음 */
  critical: boolean;
  detail: string;
}

/**
 * 실전 전환(golive.sh) 전 점검: 실제 주문이 들어왔을 때 끝까지 처리할 수 있는지 외부 연결까지 확인.
 * 부작용 없는 조회만 한다.
 */
export async function goLiveReadiness(ctx: AppContext, opts: { fetchImpl?: typeof fetch } = {}): Promise<{ ok: boolean; items: ReadinessItem[] }> {
  const s = await ctx.settings.get();
  const items: ReadinessItem[] = [];
  const add = (name: string, ok: boolean, critical: boolean, detail: string) => items.push({ name, ok, critical, detail });
  const f = opts.fetchImpl ?? fetch;

  add('긴급 정지 해제', !s.killSwitch, true, s.killSwitch ? '관리 화면에서 긴급 정지를 해제하세요' : '정상');
  add('텔레그램 알림', !!(ctx.env.TELEGRAM_BOT_TOKEN && ctx.env.TELEGRAM_CHAT_ID), true, '예외 주문·할 일을 알려주는 유일한 통로');

  const c = s.coupang;
  const missing = (['vendorUserId', 'outboundShippingPlaceCode', 'returnCenterCode', 'companyContactNumber', 'returnZipCode', 'returnAddress'] as const).filter((k) => !c[k]);
  add('쿠팡 판매자 정보(출고지·반품지 등)', !missing.length, true, missing.length ? `미입력: ${missing.join(', ')}` : '정상');

  try {
    const places = ctx.market.listShippingPlaces ? await ctx.market.listShippingPlaces() : null;
    add('쿠팡 API 연결', true, true, places ? `출고지 ${places.outbound.length}곳·반품지 ${places.returns.length}곳 확인` : '확인');
  } catch (e) {
    add('쿠팡 API 연결', false, true, errMessage(e).slice(0, 150));
  }

  const oc = ctx.sources.get('ownerclan') as (ReturnType<AppContext['sources']['get']> & { findOrderByKey?: (k: string) => Promise<unknown> }) | undefined;
  if (!oc) add('오너클랜 연결(자동 발주)', false, true, '.env 에 OWNERCLAN_USERNAME·PASSWORD 가 없습니다');
  else {
    try {
      await oc.findOrderByKey?.('golive-check');
      add('오너클랜 연결(자동 발주)', true, true, '로그인·주문 조회 권한 정상');
    } catch (e) {
      add('오너클랜 연결(자동 발주)', false, true, errMessage(e).slice(0, 150));
    }
  }

  const base = ctx.env.MEDIA_PUBLIC_BASE_URL;
  if (!s.listing.convertImages) add('이미지 공개 주소', true, false, '이미지 변환 꺼짐(공급처 이미지 주소 그대로 사용)');
  else if (!base) add('이미지 공개 주소', false, true, 'bash ~/dropship/bin/media-public.sh 를 실행하세요');
  else {
    try {
      const r = await f(`${base.replace(/\/$/, '')}/media/_ping`, { signal: AbortSignal.timeout(15_000) });
      const ok = r.ok && (await r.text()).trim() === 'ok';
      add('이미지 공개 주소', ok, true, ok ? `${base} 접속 정상(쿠팡이 이미지를 가져갈 수 있음)` : `응답 이상(${r.status}) — media-public.sh 다시 실행`);
    } catch (e) {
      add('이미지 공개 주소', false, true, `접속 실패: ${errMessage(e).slice(0, 100)} — Tailscale 실행 여부 확인 후 media-public.sh`);
    }
  }

  const sender = !!(s.orders.senderName && s.orders.senderPhone);
  add('보내는 사람(송장 표시)', sender, false, sender ? `${s.orders.senderName} / ${s.orders.senderPhone}` : `비어 있음 → 상호 대신 고객 이름·쿠팡 대표번호(${c.companyContactNumber || '-'})로 표시. 관리 화면 설정 > 주문에서 입력 권장`);

  const cand = await ctx.db.selectFrom('candidates').select((eb) => eb.fn.countAll<number>().as('n')).where('status', '=', 'new').where('passed', '=', true).executeTakeFirst();
  const n = Number(cand?.n ?? 0);
  add('등록할 후보 상품', n > 0, false, n ? `${n}개 대기` : '없음 — 다음 상품 선정(하루 1회) 후 자동 등록');

  add('오너클랜 예치금', true, false, '자동 발주는 예치금에서 결제됩니다. 처음엔 10~20만원 충전 권장(부족하면 텔레그램으로 알림)');
  return { ok: items.every((i) => i.ok || !i.critical), items };
}
