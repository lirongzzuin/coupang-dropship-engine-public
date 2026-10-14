import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, dt, won } from '../api';
import { Badge, Card, CopyButton, Loading, Msg, statusTone, useAction, useLoad } from '../ui';

interface Detail {
  id: number; market_order_id: string; shipment_box_id: string; item_name: string; qty: number; sale_amount: number;
  status: string; statusLabel: string; status_reason: string | null; ordered_at: string; ship_by: string | null;
  source_order_id: string | null; purchase_cost: number | null; purchase_shipping: number | null; expected_cost: number | null; expected_profit: number | null;
  courier_code: string | null; tracking_no: string | null; purchase_strategy: string | null; profit: number | null; settlement_amount: number | null;
  receiverMasked: { name: string; phone: string; addr: string } | null;
  source: { source: string; sourceName: string; title: string; url: string; option: string | null; price: number; shippingFee: number; apiOrder: boolean } | null;
  events: Array<{ id: number; from_status: string | null; to_status: string; reason: string | null; actor: string; at: string }>;
  profitEstimate: { profit: number; fee: number; feeVat: number; vatPayable: number; returnReserve: number } | null;
  courierAliases: string[];
  extra_cost: number;
  claims: Claim[];
}
interface Claim {
  id: number; receipt_id: string; claim_type: string; stage: string; stageLabel: string; raw_status: string; count: number | null; reason: string;
  fault_by: string | null; return_shipping_charge: number | null; action_note: string | null; reship_source_order_id: string | null; reship_cost: number | null;
  reship_tracking: string | null; requested_at: string; closed_at: string | null;
}
const CLAIM_TYPE: Record<string, string> = { CANCEL: '취소', RETURN: '취소·반품', EXCHANGE: '교환', RESHIP: '재발송' };
/** 판매자 취소 가능(아직 보내지 않음) */
const SELLER_CANCELABLE = ['NEW', 'AWAITING_PURCHASE', 'PAYMENT_PENDING', 'PURCHASED', 'OUT_OF_STOCK', 'MARGIN_NEGATIVE', 'LIMIT_EXCEEDED', 'SOURCE_ERROR', 'MANUAL_REVIEW', 'SHIPPING_DELAYED'];
/** 재발송 가능(보낸 뒤 교환·분실·파손) */
const RESHIPPABLE = ['PURCHASED', 'TRACKING_UPLOADED', 'IN_TRANSIT', 'DELIVERED', 'SETTLED', 'MANUAL_REVIEW', 'SHIPPING_DELAYED'];
interface Receiver { name: string; phone: string; addr1: string; addr2: string; zip: string; deliveryMessage: string }

const PURCHASABLE = ['AWAITING_PURCHASE', 'PAYMENT_PENDING', 'OUT_OF_STOCK', 'MARGIN_NEGATIVE', 'LIMIT_EXCEEDED', 'SOURCE_ERROR', 'MANUAL_REVIEW'];
const TRACKABLE = ['PURCHASED', 'SHIPPING_DELAYED', 'ADDRESS_CHANGED', 'MANUAL_REVIEW'];
const OVERRIDABLE = ['LIMIT_EXCEEDED', 'MARGIN_NEGATIVE', 'OUT_OF_STOCK', 'SOURCE_ERROR', 'MANUAL_REVIEW'];

export function OrderDetail() {
  const { id } = useParams();
  const { data: o, error, loading, reload } = useLoad<Detail>(`/api/orders/${id}`);
  const [rcv, setRcv] = useState<Receiver | null>(null);
  const [buy, setBuy] = useState({ sourceOrderId: '', cost: '', shippingCost: '' });
  const [trk, setTrk] = useState({ courier: '', trackingNo: '' });
  const [armed, setArmed] = useState<string | null>(null);
  const act = useAction();

  if (!o) return <Loading error={error} loading={loading} />;
  const showReceiver = () => act.run(() => api.get<Receiver>(`/api/orders/${o.id}/receiver`).then(setRcv), '배송지 열람(기록됨)');
  const fullAddr = rcv ? `${rcv.addr1} ${rcv.addr2}`.trim() : '';

  return (
    <div className="stack">
      <Card title={<>주문 #{o.id} <Badge tone={statusTone(o.status)}>{o.statusLabel}</Badge></>}>
        <div className="item-title">{o.item_name} × {o.qty}</div>
        {o.status_reason && <div className="item-reason">{o.status_reason}</div>}
        <table className="kv">
          <tbody>
            <tr><th>쿠팡 주문번호</th><td>{o.market_order_id} <CopyButton value={o.market_order_id} /></td></tr>
            <tr><th>판매금액</th><td>{won(o.sale_amount)}</td></tr>
            <tr><th>예상 원가/이익</th><td>{won(o.expected_cost)} / {won(o.expected_profit)}</td></tr>
            {o.profitEstimate && <tr><th>비용 내역</th><td className="small">수수료 {won(o.profitEstimate.fee + o.profitEstimate.feeVat)} · 부가세 {won(o.profitEstimate.vatPayable)} · 반품충당 {won(o.profitEstimate.returnReserve)}</td></tr>}
            {o.profit !== null && o.profit !== undefined && <tr><th>확정 이익</th><td>{won(o.profit)} (정산 {won(o.settlement_amount)})</td></tr>}
            <tr><th>주문 시각</th><td>{dt(o.ordered_at)}{o.ship_by && ` · 출고기한 ${o.ship_by}`}</td></tr>
            {o.source_order_id && <tr><th>공급처 주문번호</th><td>{o.source_order_id}</td></tr>}
            {o.tracking_no && <tr><th>송장</th><td>{o.courier_code} {o.tracking_no}</td></tr>}
            {o.extra_cost > 0 && <tr><th>추가 비용</th><td>{won(o.extra_cost)} (재발송 — 손익에서 차감)</td></tr>}
          </tbody>
        </table>
      </Card>

      {o.source && (
        <Card title={`공급처: ${o.source.sourceName}`} right={o.source.apiOrder ? <Badge tone="green">자동 발주</Badge> : <Badge tone="blue">직접 구매</Badge>}>
          <div>{o.source.title}</div>
          {o.source.option && <div><b>옵션: {o.source.option}</b> <span className="muted">(쿠팡에 올린 옵션 — 이 옵션으로 구매)</span> <CopyButton value={o.source.option} /></div>}
          <div className="muted">공급가 {won(o.source.price)} · 배송비 {won(o.source.shippingFee)}</div>
          {o.source.url && <a className="btn primary block" href={o.source.url} target="_blank" rel="noreferrer">공급처 상품 페이지 열기</a>}
        </Card>
      )}

      <Card title="배송지" right={!rcv && o.receiverMasked && <button className="btn small" onClick={() => void showReceiver()}>전체 보기</button>}>
        {!o.receiverMasked && <div className="muted">개인정보 보관기간이 지나 파기되었습니다.</div>}
        {o.receiverMasked && !rcv && <div>{o.receiverMasked.name} · {o.receiverMasked.phone} · {o.receiverMasked.addr}</div>}
        {rcv && (
          <table className="kv">
            <tbody>
              <tr><th>받는 분</th><td>{rcv.name} <CopyButton value={rcv.name} /></td></tr>
              <tr><th>연락처</th><td>{rcv.phone} <CopyButton value={rcv.phone} /></td></tr>
              <tr><th>우편번호</th><td>{rcv.zip} <CopyButton value={rcv.zip} /></td></tr>
              <tr><th>주소</th><td>{fullAddr} <CopyButton value={fullAddr} /></td></tr>
              <tr><th>배송메모</th><td>{rcv.deliveryMessage || '-'} {rcv.deliveryMessage && <CopyButton value={rcv.deliveryMessage} />}</td></tr>
            </tbody>
          </table>
        )}
      </Card>

      {PURCHASABLE.includes(o.status) && (
        <Card title={o.status === 'PAYMENT_PENDING' ? '공급처 결제 완료 입력' : '구매 완료 입력'}>
          <p className="muted">공급처에서 위 배송지로 결제한 뒤 주문번호와 실제 결제금액을 입력하세요. 입력하면 송장 자동 처리 단계로 넘어갑니다.</p>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void act.run(() => api.post(`/api/orders/${o.id}/purchase`, {
                sourceOrderId: buy.sourceOrderId || undefined,
                cost: buy.cost ? Number(buy.cost) : undefined,
                shippingCost: buy.shippingCost ? Number(buy.shippingCost) : undefined,
              }).then(reload), '구매 확인됨');
            }}
          >
            <label>공급처 주문번호<input value={buy.sourceOrderId} placeholder={o.source_order_id ?? ''} onChange={(e) => setBuy({ ...buy, sourceOrderId: e.target.value })} /></label>
            <div className="row">
              <label>상품 결제금액<input inputMode="numeric" value={buy.cost} placeholder={String(o.expected_cost ?? '')} onChange={(e) => setBuy({ ...buy, cost: e.target.value })} /></label>
              <label>배송비<input inputMode="numeric" value={buy.shippingCost} onChange={(e) => setBuy({ ...buy, shippingCost: e.target.value })} /></label>
            </div>
            <button className="btn primary" disabled={act.busy}>구매 완료</button>
          </form>
        </Card>
      )}

      {TRACKABLE.includes(o.status) && (
        <Card title="송장 입력">
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void act.run(() => api.post(`/api/orders/${o.id}/tracking`, trk).then(reload), '송장 등록됨');
            }}
          >
            <label>택배사<input list="couriers" value={trk.courier} onChange={(e) => setTrk({ ...trk, courier: e.target.value })} placeholder="CJ대한통운" /></label>
            <datalist id="couriers">{o.courierAliases.map((c) => <option key={c} value={c} />)}</datalist>
            <label>송장번호<input inputMode="numeric" value={trk.trackingNo} onChange={(e) => setTrk({ ...trk, trackingNo: e.target.value })} /></label>
            <button className="btn primary" disabled={act.busy}>쿠팡에 송장 등록</button>
          </form>
        </Card>
      )}

      {OVERRIDABLE.includes(o.status) && (
        <Card title="예외 처리">
          <p className="muted">확인 후 그대로 진행하려면 [강행]을 누르세요(한도·마진·재고 검사 생략). 고객 취소가 필요하면 쿠팡 Wing에서 처리 후 상태를 '취소됨'으로 바꾸세요.</p>
          <div className="row">
            <button className="btn danger" disabled={act.busy} onClick={() => void act.run(() => api.post(`/api/orders/${o.id}/override`).then(reload), '진행했습니다')}>강행</button>
            <button className="btn" disabled={act.busy} onClick={() => void act.run(() => api.post(`/api/orders/${o.id}/status`, { status: 'CANCELLED', reason: 'Wing에서 취소 처리' }).then(reload), '취소로 표시')}>취소됨으로 표시</button>
          </div>
        </Card>
      )}
      {o.claims.length > 0 && (
        <Card title="취소·반품·교환">
          {o.claims.map((c) => <ClaimRow key={c.id} o={o} c={c} act={act} reload={reload} couriers={o.courierAliases} />)}
        </Card>
      )}

      {(SELLER_CANCELABLE.includes(o.status) && !o.tracking_no) || RESHIPPABLE.includes(o.status) ? (
        <Card title="고객 주문 조치">
          <div className="row">
            {SELLER_CANCELABLE.includes(o.status) && !o.tracking_no && (
              armed === 'cancel'
                ? <button className="btn danger" disabled={act.busy} onClick={() => { setArmed(null); void act.run(() => api.post<{ message: string }>(`/api/orders/${o.id}/cancel`, { reason: 'stock' }).then((r) => { reload(); return r.message; })); }}>한 번 더 누르면 쿠팡 주문 취소</button>
                : <button className="btn" disabled={act.busy} onClick={() => setArmed('cancel')}>쿠팡 주문 취소(품절)</button>
            )}
            {RESHIPPABLE.includes(o.status) && o.source?.apiOrder && (
              armed === 'reship'
                ? <button className="btn primary" disabled={act.busy} onClick={() => { setArmed(null); void act.run(() => api.post<{ message: string }>(`/api/orders/${o.id}/reship`).then((r) => { reload(); return r.message; })); }}>한 번 더 누르면 공급처에 다시 주문</button>
                : <button className="btn" disabled={act.busy} onClick={() => setArmed('reship')}>공급처 재발송(교환·분실)</button>
            )}
          </div>
          <p className="muted small">쿠팡 주문 취소: 공급처 품절 등으로 보낼 수 없을 때. 고객은 바로 환불되고 공급처 주문도 자동 취소되지만 <b>쿠팡 판매자 점수(주문이행)가 떨어집니다</b>. 재발송: 같은 상품을 고객 주소로 다시 주문(비용은 이 주문 손익에서 차감), 송장이 나오면 알려드립니다.</p>
        </Card>
      ) : null}

      <Msg msg={act.msg} />

      <Card title="처리 이력">
        {o.events.map((e) => (
          <div key={e.id} className="event">
            <span className="muted">{dt(e.at)}</span> {e.from_status ?? '-'} → <b>{e.to_status}</b> <span className="muted">({e.actor})</span>
            {e.reason && <div className="muted">{e.reason}</div>}
          </div>
        ))}
      </Card>
    </div>
  );
}

function ClaimRow({ o, c, act, reload, couriers }: { o: Detail; c: Claim; act: ReturnType<typeof useAction>; reload: () => void; couriers: string[] }) {
  const [trk, setTrk] = useState({ courier: '', trackingNo: '' });
  const run = (body: Record<string, unknown>) => void act.run(() => api.post<{ message: string }>(`/api/orders/${o.id}/claims/${c.id}`, body).then((r) => { reload(); return r.message; }));
  const open = !c.closed_at;
  const fee = c.return_shipping_charge;
  return (
    <div className="item">
      <div className="item-head">
        <Badge tone={open ? 'amber' : 'gray'}>{CLAIM_TYPE[c.claim_type] ?? c.claim_type}</Badge>
        <b>{c.stageLabel}</b>
        <span className="muted small">접수 {c.receipt_id} · {dt(c.requested_at)}{c.closed_at ? ` · 종료 ${dt(c.closed_at)}` : ''}</span>
      </div>
      <div className="small">
        {c.reason || '사유 없음'}{c.count ? ` · ${c.count}개` : ''}{c.fault_by ? ` · 귀책 ${c.fault_by}` : ''}
        {fee != null && fee !== 0 && ` · 반품배송비 ${fee > 0 ? '판매자' : '고객'} 부담 ${won(Math.abs(fee))}`}
      </div>
      {c.action_note && <div className="muted small">처리: {c.action_note}</div>}
      {c.reship_source_order_id && <div className="small">재발송 주문 {c.reship_source_order_id} ({won(c.reship_cost)}) · 송장 {c.reship_tracking ?? '대기'} {c.reship_tracking && <CopyButton value={c.reship_tracking.split(' ').pop() ?? ''} />}</div>}
      {open && ['stop_requested', 'cancelled'].includes(c.stage) && (
        <div className="stack">
          <div className="row">
            <button className="btn primary" disabled={act.busy} onClick={() => run({ action: 'source_cancelled' })}>공급처 취소 완료{c.stage === 'stop_requested' ? '(쿠팡 출고중지)' : ''}</button>
            <button className="btn" disabled={act.busy} onClick={() => run({ action: 'close' })}>Wing에서 처리함</button>
          </div>
          {c.stage === 'stop_requested' && (
            <form className="row" onSubmit={(e) => { e.preventDefault(); run({ action: 'shipped', ...trk }); }}>
              <input list="claim-couriers" placeholder="택배사" value={trk.courier} onChange={(e) => setTrk({ ...trk, courier: e.target.value })} />
              <datalist id="claim-couriers">{couriers.map((x) => <option key={x} value={x} />)}</datalist>
              <input inputMode="numeric" placeholder="송장번호" value={trk.trackingNo} onChange={(e) => setTrk({ ...trk, trackingNo: e.target.value })} />
              <button className="btn" disabled={act.busy}>이미 발송됨(이미출고)</button>
            </form>
          )}
        </div>
      )}
      {open && ['return_requested', 'return_collected'].includes(c.stage) && (
        <div className="row">
          <button className="btn primary" disabled={act.busy} title="공급처가 반품 상품을 받았는지 확인한 뒤 누르세요" onClick={() => run({ action: 'approve_return' })}>반품 승인(환불)</button>
          <button className="btn" disabled={act.busy} onClick={() => run({ action: 'close' })}>Wing에서 처리함</button>
        </div>
      )}
      {open && ['exchange_open', 'coupang_check'].includes(c.stage) && (
        <button className="btn small" disabled={act.busy} onClick={() => run({ action: 'close' })}>처리 끝(Wing에서 처리함)</button>
      )}
    </div>
  );
}
