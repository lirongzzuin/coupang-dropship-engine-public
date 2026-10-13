import { useState } from 'react';
import { api, dt } from '../api';
import { Badge, Loading, Msg, useAction, useLoad } from '../ui';

interface Inq { id: number; kind: string; content: string; asked_at: string; status: string; draft: string | null; answer: string | null; answered_at: string | null; dry_run: boolean }

export function Inquiries() {
  const { data, error, loading, reload } = useLoad<Inq[]>('/api/inquiries');
  return (
    <div className="stack">
      <Loading error={error} loading={loading && !data} />
      {data?.length === 0 && <div className="muted pad">문의가 없습니다</div>}
      {data?.map((q) => <InqItem key={q.id} q={q} onDone={reload} />)}
    </div>
  );
}

function InqItem({ q, onDone }: { q: Inq; onDone: () => void }) {
  const [text, setText] = useState(q.draft ?? '');
  const act = useAction();
  return (
    <div className="item">
      <div className="item-head">
        <Badge tone={q.status === 'answered' ? 'green' : 'blue'}>{q.status === 'answered' ? '답변완료' : '답변 필요'}</Badge>
        {q.dry_run && q.status === 'answered' && <Badge tone="amber">모의</Badge>}
        <span className="muted">{dt(q.asked_at)}</span>
      </div>
      <div className="pre">{q.content}</div>
      {q.status === 'answered' ? (
        <div className="answer pre">{q.answer}</div>
      ) : (
        <form className="form" onSubmit={(e) => {
          e.preventDefault();
          void act.run(() => api.post(`/api/inquiries/${q.id}/answer`, { text }).then(onDone), '답변 등록');
        }}>
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="답변 내용" />
          <button className="btn primary" disabled={act.busy}>답변 보내기</button>
        </form>
      )}
      <Msg msg={act.msg} />
    </div>
  );
}
