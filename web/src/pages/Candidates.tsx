import { useEffect, useState } from 'react';
import { api, dt, won } from '../api';
import { Badge, Card, Loading, Msg, useAction, useLoad } from '../ui';
import { Keywords } from './Keywords';
import { startJob, useRefreshWhile } from './Jobs';

interface Gate { name: string; pass: boolean; detail: string; hard: boolean }
interface Cand {
  id: number; keyword: string; score: number; passed: boolean; target_price: number | null; est_profit: number | null; est_margin: number | null;
  market_lowest: number | null; status: string; gates: Gate[]; title: string; source: string; price: number; shipping_fee: number; url: string;
  image_url: string | null; image_reuse_allowed: boolean;
  signals?: { demand?: { sales: number; profit: number; factors?: Record<string, number> }; keywordMedianPrice?: number; searchVolume?: number; competition?: string } | null;
}

const GATE_LABEL: Record<string, string> = {
  status: '판매상태', stock: '재고', relevance: '키워드 일치', allowedCategory: '허용 분류', moq: '최소주문', supplyPrice: '공급가 범위', trademark: '상표', category: '금지 카테고리', kc: 'KC 인증',
  profit: '이익', competitive: '가격 경쟁력', prepDays: '출고일', sellerQuality: '판매자 평가', images: '이미지', notice: '고시정보', apiOrder: '자동 발주',
};

interface JobsInfo { jobs: Array<{ name: string; label: string; running: boolean; last: { started_at: string; finished_at: string | null; ok: boolean | null; error: string | null; stats: { evaluated?: number; passed?: number; autoListed?: number } | null } | null }> }

/** 지금 상품 선정 실행 = bash ~/dropship/bin/run-job.sh selection.run (자동 선정과 같은 작업, 백그라운드) */
function SelectionRunCard({ onDone }: { onDone: () => void }) {
  const { data, reload } = useLoad<JobsInfo>('/api/jobs');
  const act = useAction();
  const job = data?.jobs.find((j) => j.name === 'selection.run');
  const running = !!job?.running;
  const [wasRunning, setWasRunning] = useState(false);
  useRefreshWhile(running, reload);
  // 실행이 끝나면 후보 목록도 새로
  useEffect(() => {
    if (wasRunning && !running) onDone();
    setWasRunning(running);
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps
  const last = job?.last;
  const stats = last?.stats && typeof last.stats === 'object' ? last.stats : null;
  return (
    <Card title="상품 선정" right={running ? <Badge tone="blue">실행 중</Badge> : last ? <Badge tone={last.ok ? 'green' : last.ok === false ? 'red' : 'gray'}>{last.ok ? '정상' : last.ok === false ? '실패' : '진행'}</Badge> : null}>
      <div className="muted small">
        자동 선정과 같은 작업을 지금 바로 실행합니다(키워드 풀 → 공급처 후보 → 조건 확인 → 상위 후보 자동 등록, 10분 이상 걸릴 수 있음). 끝나면 텔레그램으로 결과가 옵니다. 다음 자동 실행은 이 실행 24시간 뒤입니다.
      </div>
      {last && <div className="small">마지막 실행 {dt(last.started_at)}{stats ? ` · 검토 ${stats.evaluated ?? 0} · 통과 ${stats.passed ?? 0} · 자동 등록 ${stats.autoListed ?? 0}` : ''}{last.error ? ` · 오류: ${last.error}` : ''}</div>}
      <button className="btn primary" disabled={act.busy || running} onClick={() => void act.run(async () => {
        const msg = await startJob('selection.run');
        reload();
        return msg;
      })}>{running ? '실행 중…' : '지금 상품 선정 실행'}</button>
      <Msg msg={act.msg} />
    </Card>
  );
}

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
      <SelectionRunCard onDone={reload} />
      <Card title="키워드 지정해서 선정">
        <form className="form" onSubmit={(e) => {
          e.preventDefault();
          const keywords = kw.split(',').map((x) => x.trim()).filter(Boolean);
          void act.run(async () => {
            const r = await api.post<{ evaluated: number; passed: number; autoListed: number; errors: string[] }>('/api/selection/run', { keywords });
            reload();
            return `평가 ${r.evaluated} · 통과 ${r.passed} · 자동등록 ${r.autoListed}${r.errors.length ? ` · 오류 ${r.errors.length}` : ''}`;
          });
        }}>
          <label>키워드(쉼표 구분) — 이 키워드로만 선정. 평소엔 위 [지금 상품 선정 실행]을 쓰세요<input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="수납 정리함, 캠핑 의자" /></label>
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
          {c.signals?.demand && (
            <div className="item-sub">
              기대 월 {c.signals.demand.sales}개 · 월이익 {won(c.signals.demand.profit)} · 검색량 {c.signals.searchVolume?.toLocaleString() ?? '?'}
              {c.signals.competition ? ` · 경쟁 ${c.signals.competition}` : ''}
              {c.signals.keywordMedianPrice ? ` · 키워드 중앙가 ${won(c.signals.keywordMedianPrice)}` : ''}
            </div>
          )}
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
