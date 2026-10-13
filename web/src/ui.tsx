import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { api } from './api';

/** 데이터 로딩 훅: [data, error, reload] */
export function useLoad<T>(url: string | null, deps: unknown[] = []): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    setLoading(true);
    api.get<T>(url)
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, n, ...deps]);
  return { data, error, loading, reload: useCallback(() => setN((x) => x + 1), []) };
}

/** 버튼 클릭 → 비동기 작업 실행 + 에러/성공 메시지 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  /** fn 이 문자열을 반환하면 그 문자열을 성공 메시지로 표시 */
  const run = useCallback(async (fn: () => Promise<unknown>, okText = '완료') => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      setMsg({ ok: true, text: typeof r === 'string' ? r : okText });
      return true;
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, msg, run, setMsg };
}

export function Msg({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <div className={`msg ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>;
}

export function Card({ title, children, right }: { title?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="card">
      {(title || right) && (
        <div className="card-head">
          <h3>{title}</h3>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Badge({ tone = 'gray', children }: { tone?: 'gray' | 'green' | 'red' | 'amber' | 'blue'; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          const ta = document.createElement('textarea');
          ta.value = value;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? '복사됨' : label ?? '복사'}
    </button>
  );
}

export function Loading({ error, loading }: { error: string | null; loading: boolean }) {
  if (error) return <div className="msg err">{error}</div>;
  if (loading) return <div className="muted pad">불러오는 중…</div>;
  return null;
}

export function statusTone(status: string): 'gray' | 'green' | 'red' | 'amber' | 'blue' {
  if (['AWAITING_PURCHASE', 'PAYMENT_PENDING'].includes(status)) return 'blue';
  if (['DELIVERED', 'SETTLED', 'TRACKING_UPLOADED', 'IN_TRANSIT', 'PURCHASED', 'active'].includes(status)) return 'green';
  if (['CANCELLED', 'RETURNED', 'stopped', 'rejected'].includes(status)) return 'gray';
  if (['NEW', 'pending_approval', 'draft'].includes(status)) return 'gray';
  return status === 'paused' ? 'amber' : 'red';
}
