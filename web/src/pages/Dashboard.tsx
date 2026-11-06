import { Link } from 'react-router-dom';
import { api, dt, won } from '../api';
import { Badge, Card, Loading, Msg, useAction, useLoad } from '../ui';

interface Dash {
  today: { orders: number; sales: number; expectedProfit: number };
  yesterday: { orders: number; sales: number; expectedProfit: number };
  month: { orders: number; sales: number; expectedProfit: number; settledProfit: number };
  actionCount: number;
  exceptionCount: number;
  listings: Record<string, number>;
  candidatesNew: number;
  inquiriesOpen: number;
  lastOrderPollAt: string | null;
  publicIp: string | null;
  keyExpiresInDays: number | null;
  killSwitch: boolean;
  dryRun: boolean;
  live: Record<string, boolean>;
}
interface Safety { halt: { reason: string; at: string; by: 'auto' | 'manual' } | null; issues: Array<{ key: string; message: string; fix: string; since: string }> }
interface LP { listingId: number; title: string; salePrice: number; markup: number; status: string; orders: number; revenue: number; expectedProfit: number; settledProfit: number }
interface Noti { id: number; level: string; title: string; body: string; link: string | null; pushed?: boolean; at: string }

export function Dashboard() {
  const d = useLoad<Dash>('/api/dashboard');
  const n = useLoad<Noti[]>('/api/notifications');
  const lp = useLoad<LP[]>('/api/finance/listings?days=30');
  const sf = useLoad<Safety>('/api/safety');
  const act = useAction();
  const x = d.data;
  return (
    <div className="stack">
      <Loading error={d.error} loading={d.loading && !x} />
      {x && (
        <>
          <div className="banner-row">
            {x.dryRun ? <Badge tone="amber">모의 실행(DRY_RUN)</Badge> : <Badge tone="green">실운영</Badge>}
            {Object.entries(x.live).filter(([, v]) => v).map(([k]) => <Badge key={k} tone="blue">LIVE {k}</Badge>)}
            {x.killSwitch && <Badge tone="red">긴급 정지 중</Badge>}
          </div>
          {sf.data?.halt && (
            <Card title="🛑 판매 중지 중(안전장치)">
              <div>사유: {sf.data.halt.reason}</div>
              <div className="muted small">{sf.data.halt.by === 'auto' ? '자동' : '수동'} · {dt(sf.data.halt.at)} · 새 주문이 들어오지 않도록 쿠팡 판매를 멈췄습니다. 이미 결제된 주문은 계속 처리합니다.</div>
              <div className="row">
                <button className="btn primary" disabled={act.busy} onClick={() => void act.run(() => api.post('/api/safety/resume', {}).then(() => { sf.reload(); d.reload(); }), '판매를 재개했습니다')}>문제 해결 — 판매 재개</button>
              </div>
            </Card>
          )}
          {(sf.data?.issues ?? []).length > 0 && (
            <Card title={`⚠️ 해결할 문제 ${sf.data!.issues.length}건`}>
              {sf.data!.issues.map((i) => (
                <div key={i.key} className="event">
                  <b>{i.message}</b>
                  <div className="small">→ {i.fix}</div>
                  <div className="muted small">감지 {dt(i.since)}{!sf.data!.halt ? ' · 해결하지 않으면 자동으로 판매 중지' : ''}</div>
                </div>
              ))}
            </Card>
          )}
          <div className="grid2">
            <Link to="/orders?view=action" className={`stat ${x.actionCount ? 'hot' : ''}`}><span>구매·결제 할 일</span><b>{x.actionCount}</b></Link>
            <Link to="/orders?view=exception" className={`stat ${x.exceptionCount ? 'warn' : ''}`}><span>예외</span><b>{x.exceptionCount}</b></Link>
            <Link to="/inquiries" className="stat"><span>답변 대기 문의</span><b>{x.inquiriesOpen}</b></Link>
            <Link to="/candidates" className="stat"><span>새 후보</span><b>{x.candidatesNew}</b></Link>
          </div>
          <Card title="매출">
            <table className="kv">
              <tbody>
                <tr><th>오늘</th><td>{x.today.orders}건 · {won(x.today.sales)} · 예상이익 {won(x.today.expectedProfit)}</td></tr>
                <tr><th>어제</th><td>{x.yesterday.orders}건 · {won(x.yesterday.sales)} · 예상이익 {won(x.yesterday.expectedProfit)}</td></tr>
                <tr><th>이번 달</th><td>{x.month.orders}건 · {won(x.month.sales)} · 예상 {won(x.month.expectedProfit)} · 확정 {won(x.month.settledProfit)}</td></tr>
              </tbody>
            </table>
          </Card>
          <Card title="운영 상태">
            <table className="kv">
              <tbody>
                <tr><th>판매중 상품</th><td>{x.listings.active ?? 0} (심사중 {x.listings.pending_approval ?? 0} · 중지 {x.listings.paused ?? 0} · 초안 {x.listings.draft ?? 0})</td></tr>
                <tr><th>마지막 주문 수집</th><td>{dt(x.lastOrderPollAt)}</td></tr>
                <tr><th>서버 공인 IP</th><td>{x.publicIp ?? '확인 중'} <span className="muted small">(쿠팡 Wing 허용 IP와 같아야 함)</span></td></tr>
                <tr><th>쿠팡 API 키</th><td>{x.keyExpiresInDays === null ? '발급일 미입력(설정)' : <>만료까지 {x.keyExpiresInDays}일 {x.keyExpiresInDays <= 14 && <Badge tone="red">재발급 필요</Badge>}</>}</td></tr>
              </tbody>
            </table>
            <div className="row">
              <button
                className={`btn ${x.killSwitch ? 'primary' : 'danger'}`}
                disabled={act.busy}
                onClick={() => void act.run(() => api.post('/api/kill-switch', { on: !x.killSwitch }).then(d.reload), x.killSwitch ? '재개했습니다' : '긴급 정지했습니다')}
              >
                {x.killSwitch ? '자동 운영 재개' : '긴급 정지'}
              </button>
              <Link className="btn" to="/jobs">작업·로그</Link>
            </div>
            <Msg msg={act.msg} />
          </Card>
        </>
      )}
      <Card title="상품별 이익(최근 30일)">
        {(lp.data ?? []).length === 0 && <div className="muted">아직 주문이 없습니다</div>}
        {(lp.data ?? []).slice(0, 10).map((x) => (
          <div key={x.listingId} className="event">
            <b>{x.title.slice(0, 28)}</b> <span className="muted small">마크업 {Math.round(x.markup * 100)}%</span>
            <div className="small">{x.orders}건 · 매출 {won(x.revenue)} · 예상이익 <b>{won(x.expectedProfit)}</b>{x.settledProfit ? ` · 확정 ${won(x.settledProfit)}` : ''}</div>
          </div>
        ))}
        <div className="muted small">가격은 매일 판매 결과에 따라 자동 조정됩니다(잘 팔리면 인상, 안 팔리면 인하).</div>
      </Card>
      <Card title="최근 알림">
        {(n.data ?? []).slice(0, 15).map((m) => (
          <div key={m.id} className={`noti ${m.level}`}>
            <div className="noti-head"><b>{m.title}</b><span className="muted">{m.pushed ? '📱 ' : ''}{dt(m.at)}</span></div>
            <div className="pre">{m.body}</div>
            {m.link && <a href={new URL(m.link).pathname}>열기</a>}
          </div>
        ))}
        {n.data?.length === 0 && <div className="muted">알림이 없습니다</div>}
        <div className="muted small">📱 = 텔레그램으로도 보낸 알림(주문·CS·서버 문제). 상품 등록·변경 같은 자동 운영 알림은 여기에만 기록됩니다.</div>
      </Card>
    </div>
  );
}
