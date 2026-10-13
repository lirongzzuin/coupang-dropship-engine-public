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
  source: { source: string; sourceName: string; title: string; url: string; price: number; shippingFee: number; apiOrder: boolean } | null;
  events: Array<{ id: number; from_status: string | null; to_status: string; reason: string | null; actor: string; at: string }>;
  profitEstimate: { profit: number; fee: number; feeVat: number; vatPayable: number; returnReserve: number } | null;
  courierAliases: string[];
}
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
          </tbody>
        </table>
      </Card>

      {o.source && (
        <Card title={`공급처: ${o.source.sourceName}`} right={o.source.apiOrder ? <Badge tone="green">자동 발주</Badge> : <Badge tone="blue">직접 구매</Badge>}>
          <div>{o.source.title}</div>
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
