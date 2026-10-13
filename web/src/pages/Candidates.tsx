import { useState } from 'react';
import { api, won } from '../api';
import { Badge, Card, Loading, Msg, useAction, useLoad } from '../ui';
import { Keywords } from './Keywords';

interface Gate { name: string; pass: boolean; detail: string; hard: boolean }
interface Cand {
  id: number; keyword: string; score: number; passed: boolean; target_price: number | null; est_profit: number | null; est_margin: number | null;
  market_lowest: number | null; status: string; gates: Gate[]; title: string; source: string; price: number; shipping_fee: number; url: string;
  image_url: string | null; image_reuse_allowed: boolean;
}

const GATE_LABEL: Record<string, string> = {
  status: '판매상태', stock: '재고', relevance: '키워드 일치', allowedCategory: '허용 분류', moq: '최소주문', supplyPrice: '공급가 범위', trademark: '상표', category: '금지 카테고리', kc: 'KC 인증',
  profit: '이익', competitive: '가격 경쟁력', images: '이미지', notice: '고시정보', apiOrder: '자동 발주',
};

export function Candidates() {
  const [view, setView] = useState<'cands' | 'keywords'>('cands');
  const [passed, setPassed] = useState<'true' | 'false'>('true');
  const { data, error, loading, reload } = useLoad<Cand[]>(`/api/candidates?status=new&passed=${passed}`);
  const [kw, setKw] = useState('');
  const act = useAction();
  // 후보 승인/제외 결과는 항목이 목록에서 사라지므로 페이지 상단에 표시
  const itemAct = useAction();
  const switcher = (
    <div className="tabs">
      <button className={view === 'cands' ? 'on' : ''} onClick={() => setView('cands')}>상품 후보</button>
      <button className={view === 'keywords' ? 'on' : ''} onClick={() => setView('keywords')}>키워드 풀</button>
    </div>
  );
  if (view === 'keywords') return <div className="stack">{switcher}<Keywords /></div>;
  return (
    <div className="stack">
      {switcher}
      <Card title="상품 선정 실행">
        <form className="form" onSubmit={(e) => {
          e.preventDefault();
          const keywords = kw.split(',').map((x) => x.trim()).filter(Boolean);
          void act.run(async () => {
            const r = await api.post<{ evaluated: number; passed: number; autoListed: number; errors: string[] }>('/api/selection/run', { keywords });
            reload();
            return `평가 ${r.evaluated} · 통과 ${r.passed} · 자동등록 ${r.autoListed}${r.errors.length ? ` · 오류 ${r.errors.length}` : ''}`;
          });
        }}>
          <label>키워드(쉼표 구분, 비우면 키워드 풀에서 자동 선택)<input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="수납 정리함, 캠핑 의자" /></label>
          <button className="btn primary" disabled={act.busy}>{act.busy ? '실행 중…' : '실행'}</button>
        </form>
        <Msg msg={act.msg} />
      </Card>
      <div className="tabs">
        <button className={passed === 'true' ? 'on' : ''} onClick={() => setPassed('true')}>통과</button>
        <button className={passed === 'false' ? 'on' : ''} onClick={() => setPassed('false')}>탈락(사유)</button>
      </div>
      <Loading error={error} loading={loading && !data} />
      {data?.length === 0 && <div className="muted pad">후보가 없습니다</div>}
      <Msg msg={itemAct.msg} />
      {data?.map((c) => <CandItem key={c.id} c={c} act={itemAct} onDone={reload} />)}
    </div>
  );
}

function CandItem({ c, act, onDone }: { c: Cand; act: ReturnType<typeof useAction>; onDone: () => void }) {
  return (
    <div className="item">
      <div className="item-head">
        <Badge tone={c.passed ? 'green' : 'gray'}>점수 {c.score.toFixed(2)}</Badge>
        <span className="muted">{c.source} · {c.keyword}</span>
      </div>
      <div className="cand">
        {c.image_url && <img src={c.image_url} alt="" />}
        <div>
          <a className="item-title" href={c.url} target="_blank" rel="noreferrer">{c.title}</a>
          <div className="item-sub">공급 {won(c.price)}+{won(c.shipping_fee)} → 판매 {won(c.target_price)} · 이익 {won(c.est_profit)} ({c.est_margin ? `${Math.round(c.est_margin * 100)}%` : '-'}) · 시장최저 {won(c.market_lowest)}</div>
        </div>
      </div>
      <div className="gates">
        {c.gates.map((g) => <span key={g.name} className={`gate ${g.pass ? 'ok' : g.hard ? 'fail' : 'warn'}`} title={g.detail}>{GATE_LABEL[g.name] ?? g.name}</span>)}
      </div>
      {!c.passed && <div className="item-reason">{c.gates.filter((g) => g.hard && !g.pass).map((g) => `${GATE_LABEL[g.name] ?? g.name}: ${g.detail}`).join(' / ')}</div>}
      {c.passed && (
        <div className="row">
          <button className="btn primary" disabled={act.busy} onClick={() => void act.run(() => api.post(`/api/candidates/${c.id}/approve`).then(onDone), `초안 생성: ${c.title} (상품 탭에서 확인·등록)`)}>승인 → 초안</button>
          <button className="btn" disabled={act.busy} onClick={() => void act.run(() => api.post(`/api/candidates/${c.id}/reject`).then(onDone), `제외: ${c.title}`)}>제외</button>
        </div>
      )}
    </div>
  );
}
