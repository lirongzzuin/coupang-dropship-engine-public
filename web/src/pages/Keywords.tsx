import { useState } from 'react';
import { api, dt } from '../api';
import { Badge, Card, Msg, useAction, useLoad } from '../ui';

interface Kw {
  keyword: string; origin: string; status: string; category: string | null; volume: number | null; competition: string | null;
  score: number; runs: number; passed_total: number; listed_total: number; note: string | null; last_used_at: string | null;
}
const ORIGIN: Record<string, string> = { manual: '직접', category: '카테고리', title: '인기상품명', related: '연관검색어', winner: '판매실적' };
const STATUS: Record<string, { label: string; tone: 'green' | 'blue' | 'amber' | 'gray' | 'red' }> = {
  pinned: { label: '고정', tone: 'blue' }, active: { label: '사용', tone: 'green' }, paused: { label: '일시중지', tone: 'amber' }, blocked: { label: '제외', tone: 'gray' },
};

/** 자동 발굴된 키워드 풀: 고정(항상 사용)·제외·직접 추가 */
export function Keywords() {
  const [filter, setFilter] = useState('');
  const { data, reload } = useLoad<{ rows: Kw[]; counts: Record<string, number> }>(`/api/keywords${filter ? `?status=${filter}` : ''}`);
  const [add, setAdd] = useState('');
  const act = useAction();
  const set = (keyword: string, status: string) => act.run(() => api.post('/api/keywords/status', { keyword, status }).then(reload), `${keyword}: ${STATUS[status]?.label}`);
  const c = data?.counts ?? {};
  return (
    <div className="stack">
      <Card title="키워드 자동 발굴" right={<button className="btn small" disabled={act.busy} onClick={() => void act.run(async () => {
        const r = await api.post<{ categories: number; hints: number; found: number; added: number; updated: number; errors: string[] }>('/api/keywords/discover');
        reload();
        return `카테고리 ${r.categories} · 후보 ${r.hints} · 검색광고 ${r.found} → 추가 ${r.added}, 갱신 ${r.updated}${r.errors.length ? ` · 경고: ${r.errors[0]}` : ''}`;
      })}>{act.busy ? '발굴 중…' : '지금 발굴'}</button>}>
        <div className="muted small">
          공급처 인기상품·카테고리에서 키워드를 뽑아 네이버 검색광고의 월간 검색량·경쟁도로 검증해 모읍니다(3일마다 자동).
          상품 선정은 매일 점수가 높은 키워드를 돌아가며 사용하고, 결과가 없는 키워드는 자동으로 일시중지됩니다.
        </div>
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (add.trim()) void set(add.trim(), 'pinned').then(() => setAdd('')); }}>
          <label>직접 추가(고정)<input value={add} onChange={(e) => setAdd(e.target.value)} placeholder="예: 캠핑 의자" /></label>
          <button className="btn">추가</button>
        </form>
        <Msg msg={act.msg} />
      </Card>
      <div className="tabs scroll">
        {['', 'pinned', 'active', 'paused', 'blocked'].map((f) => (
          <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
            {f ? STATUS[f]!.label : '전체'} {f ? (c[f] ?? 0) : Object.values(c).reduce((a, b) => a + b, 0)}
          </button>
        ))}
      </div>
      {data?.rows.length === 0 && <div className="muted pad">키워드가 없습니다. [지금 발굴]을 누르거나 직접 추가하세요.</div>}
      {data?.rows.map((k) => (
        <div key={k.keyword} className="item">
          <div className="item-head">
            <span><b>{k.keyword}</b> <Badge tone={STATUS[k.status]?.tone ?? 'gray'}>{STATUS[k.status]?.label ?? k.status}</Badge></span>
            <span className="muted small">점수 {k.score.toFixed(2)}</span>
          </div>
          <div className="item-sub">
            월 검색 {k.volume?.toLocaleString() ?? '-'} · 경쟁 {k.competition ?? '-'} · {ORIGIN[k.origin] ?? k.origin}
            {k.category && ` · ${k.category}`} · 사용 {k.runs}회(통과 {k.passed_total}, 등록 {k.listed_total}) · 최근 {dt(k.last_used_at)}
          </div>
          {k.note && <div className="item-reason">{k.note}</div>}
          <div className="row">
            {k.status !== 'pinned' && <button className="btn small" onClick={() => void set(k.keyword, 'pinned')}>고정</button>}
            {k.status !== 'active' && <button className="btn small" onClick={() => void set(k.keyword, 'active')}>사용</button>}
            {k.status !== 'blocked' && <button className="btn small" onClick={() => void set(k.keyword, 'blocked')}>제외</button>}
          </div>
        </div>
      ))}
    </div>
  );
}
