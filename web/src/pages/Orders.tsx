import { Link, useSearchParams } from 'react-router-dom';
import { dt, won } from '../api';
import { Badge, Loading, statusTone, useLoad } from '../ui';

interface OrderRow {
  id: number; market: string; market_order_id: string; item_name: string; qty: number; sale_amount: number; status: string; statusLabel: string;
  status_reason: string | null; ordered_at: string; ship_by: string | null; expected_profit: number | null; profit: number | null;
  tracking_no: string | null; source: string | null; receiver: string; purchase_strategy: string | null;
}

const VIEWS = [
  { v: 'action', label: '할 일' },
  { v: 'exception', label: '예외' },
  { v: 'active', label: '진행중' },
  { v: 'all', label: '전체' },
];

export function Orders() {
  const [sp, setSp] = useSearchParams();
  const view = sp.get('view') ?? 'action';
  const { data, error, loading } = useLoad<OrderRow[]>(`/api/orders?view=${view}`);
  return (
    <div className="stack">
      <div className="tabs">
        {VIEWS.map((x) => (
          <button key={x.v} className={view === x.v ? 'on' : ''} onClick={() => setSp({ view: x.v })}>{x.label}</button>
        ))}
      </div>
      <Loading error={error} loading={loading && !data} />
      {data?.length === 0 && <div className="muted pad">{view === 'action' ? '할 일이 없습니다 👍' : '주문이 없습니다'}</div>}
      {data?.map((o) => (
        <Link key={o.id} to={`/orders/${o.id}`} className="item">
          <div className="item-head">
            <Badge tone={statusTone(o.status)}>{o.statusLabel}</Badge>
            {o.market === 'naver' && <Badge tone="green">스마트스토어</Badge>}
            <span className="muted">{dt(o.ordered_at)}</span>
          </div>
          <div className="item-title">{o.item_name} × {o.qty}</div>
          <div className="item-sub">
            {won(o.sale_amount)} · 이익 {won(o.profit ?? o.expected_profit)} · {o.receiver} · {o.source ?? '미매핑'}
            {o.ship_by && <> · 출고기한 {o.ship_by}</>}
          </div>
          {o.status_reason && <div className="item-reason">{o.status_reason}</div>}
        </Link>
      ))}
    </div>
  );
}
