import { useEffect, useState } from 'react';
import { api, dt } from '../api';
import { Badge, Card, Loading, Msg, useAction, useLoad } from '../ui';

interface Run { id: number; job: string; started_at: string; finished_at: string | null; ok: boolean | null; error: string | null; stats: unknown }
interface Jobs { jobs: Array<{ name: string; label: string; running: boolean; last: Run | null }>; runs: Run[] }

/** 실행 중인 작업이 있으면 끝날 때까지 몇 초마다 새로고침 */
export function useRefreshWhile(active: boolean, reload: () => void, ms = 5000): void {
  useEffect(() => {
    if (!active) return;
    const t = setInterval(reload, ms);
    return () => clearInterval(t);
  }, [active, reload, ms]);
}

/** 작업 지금 실행(= bash ~/dropship/bin/run-job.sh <작업>) — 백그라운드로 시작하고 바로 돌아옴 */
export async function startJob(name: string): Promise<string> {
  const r = await api.post<{ started: string; label: string }>(`/api/jobs/${name}/run`);
  return `'${r.label}' 시작했습니다 — 끝나면 텔레그램으로 결과가 옵니다(이 화면에서도 진행 상태 확인)`;
}

export function Jobs() {
  const { data, error, loading, reload } = useLoad<Jobs>('/api/jobs');
  const act = useAction();
  useRefreshWhile(!!data?.jobs.some((j) => j.running), reload);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [tool, setTool] = useState('itemscout');
  return (
    <div className="stack">
      <Card title="자동 작업" right={<button className="btn small" onClick={reload}>새로고침</button>}>
        <Loading error={error} loading={loading && !data} />
        {data?.jobs.map((j) => (
          <div key={j.name} className="jobrow">
            <div>
              <b>{j.label}</b>{' '}
              {j.running ? <Badge tone="blue">실행 중</Badge> : j.last ? <Badge tone={j.last.ok ? 'green' : j.last.ok === false ? 'red' : 'gray'}>{j.last.ok ? '정상' : j.last.ok === false ? '실패' : '진행'}</Badge> : <Badge>대기</Badge>}
              <div className="muted small">마지막 {dt(j.last?.started_at)} {j.last?.error && `· ${j.last.error}`}</div>
            </div>
            <button className="btn small" disabled={act.busy || j.running} onClick={() => void act.run(async () => {
              const msg = await startJob(j.name);
              reload();
              return msg;
            })}>{j.running ? '실행 중…' : '지금 실행'}</button>
          </div>
        ))}
        <Msg msg={act.msg} />
      </Card>

      <Card title="월 손익 CSV">
        <div className="row">
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          <a className="btn" href={`/api/finance/monthly.csv?month=${month}`}>내려받기</a>
        </div>
      </Card>

      <Card title="쿠팡 판매량 추정 CSV 가져오기">
        <p className="muted">외부 분석 툴에서 내보낸 CSV(열: 키워드, 판매량). 값은 추정치로만 사용됩니다.</p>
        <div className="row">
          <input value={tool} onChange={(e) => setTool(e.target.value)} placeholder="툴 이름" />
          <input type="file" accept=".csv,text/csv" onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            void act.run(async () => {
              const r = await api.post<{ imported: number; skipped: number }>(`/api/market-data/coupang-sales?tool=${encodeURIComponent(tool)}`, f, 'text/csv');
              return `가져옴 ${r.imported} · 건너뜀 ${r.skipped}`;
            });
          }} />
        </div>
      </Card>

      <Card title="최근 실행 기록">
        {data?.runs.slice(0, 40).map((r) => (
          <div key={r.id} className="event">
            <span className="muted">{dt(r.started_at)}</span> <b>{r.job}</b> {r.ok === false ? <Badge tone="red">실패</Badge> : r.ok ? <Badge tone="green">ok</Badge> : <Badge>…</Badge>}
            {r.error && <div className="item-reason">{r.error}</div>}
            {r.ok && r.stats != null && <div className="muted small mono">{JSON.stringify(r.stats)}</div>}
          </div>
        ))}
      </Card>
    </div>
  );
}
