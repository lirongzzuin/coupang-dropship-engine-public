import { useState } from 'react';
import { api, dt, won } from '../api';
import { Badge, Loading, Msg, statusTone, useAction, useLoad } from '../ui';
import { LinkTool } from './LinkTool';

/** 출시 기간(설정 pricing.launchDays 기본값) — 표시용 */
const LAUNCH_DAYS = 10;

interface Listing {
  id: number; title: string; status: string; status_reason: string | null; sale_price: number; floor_price: number; markup: number; target_markup: number | null; fee_rate_actual: number | null; images: string[];
  vendor_item_id: string | null; seller_product_id: string | null; category_code: string | null; category_name: string | null; search_tags: string[];
  dry_run: boolean; listed_at: string | null; source: string; source_price: number; source_shipping: number; source_stock: number | null;
  source_url: string; image_reuse_allowed: boolean;
  source_option: string | null; checked_at: string | null; order_checked_at: string | null; check_fails: number;
  winner_status: 'winner' | 'not_winner' | null; winner_price: number | null; winner_checked_at: string | null;
}

/** 공급처 확인·주문 가능 점검 시각(판매중·일시중지 상품만) */
function checkLine(l: Listing): string | null {
  if (!['active', 'paused'].includes(l.status)) return null;
  const parts = [`공급처 확인 ${l.checked_at ? dt(l.checked_at) : '전'}`];
  if (l.order_checked_at) parts.push(`주문 가능 점검 ${dt(l.order_checked_at)}`);
  if (l.check_fails) parts.push(`조회 실패 ${l.check_fails}회 연속`);
  return parts.join(' · ');
}

const STATUS_LABEL: Record<string, string> = { draft: '초안', pending_approval: '심사중', active: '판매중', paused: '일시중지', stopped: '판매종료', rejected: '반려' };
const FILTERS = ['', 'draft', 'pending_approval', 'active', 'paused', 'stopped', 'rejected'];

export function Listings() {
  const [filter, setFilter] = useState('');
  const { data, error, loading, reload } = useLoad<Listing[]>(`/api/listings${filter ? `?status=${filter}` : ''}`);
  const [open, setOpen] = useState<number | null>(null);
  // 등록·중지 등으로 항목이 현재 필터에서 사라져도 결과가 보이도록 페이지 상단에 표시
  const act = useAction();
  return (
    <div className="stack">
      <LinkTool onLinked={reload} />
      <Msg msg={act.msg} />
      <div className="tabs scroll">
        {FILTERS.map((f) => <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{f ? STATUS_LABEL[f] : '전체'}</button>)}
      </div>
      <Loading error={error} loading={loading && !data} />
      {data?.length === 0 && <div className="muted pad">상품이 없습니다. 후보 탭에서 승인하거나 자동 선정을 기다리세요.</div>}
      {data?.map((l) => (
        <div key={l.id} className="item">
          <div className="item-head" onClick={() => setOpen(open === l.id ? null : l.id)}>
            <Badge tone={statusTone(l.status)}>{STATUS_LABEL[l.status] ?? l.status}</Badge>
            {l.dry_run && l.status !== 'draft' && <Badge tone="amber">모의</Badge>}
            {l.status === 'active' && l.listed_at && Date.now() - new Date(l.listed_at).getTime() < LAUNCH_DAYS * 86400_000 && <Badge tone="blue">출시 가격</Badge>}
            {l.winner_status === 'winner' && <Badge tone="green">위너</Badge>}
            {l.winner_status === 'not_winner' && <Badge tone="amber">위너 아님 {l.winner_price ? won(l.winner_price) : ''}</Badge>}
            {l.status === 'active' && !l.dry_run && !l.winner_status && <Badge tone="blue">위너 확인 필요</Badge>}
            <span className="muted">{l.source}</span>
          </div>
          <div className="item-title" onClick={() => setOpen(open === l.id ? null : l.id)}>{l.title}</div>
          <div className="item-sub">판매가 {won(l.sale_price)} (하한 {won(l.floor_price)}, 마크업 {Math.round(l.markup * 100)}%{l.target_markup !== null && l.markup < l.target_markup ? ` → 목표 ${Math.round(l.target_markup * 100)}%` : ''}) · 공급가 {won(l.source_price)}+{won(l.source_shipping)} · 재고 {l.source_stock ?? '?'}{l.fee_rate_actual ? ` · 실수수료 ${(l.fee_rate_actual * 100).toFixed(1)}%` : ''}</div>
          {l.source_option && <div className="item-sub">발주 옵션: {l.source_option}</div>}
          {checkLine(l) && <div className="item-sub muted">{checkLine(l)}</div>}
          {l.status_reason && <div className="item-reason">{l.status_reason}</div>}
          {open === l.id && <ListingEditor l={l} act={act} onChange={reload} />}
        </div>
      ))}
    </div>
  );
}

interface WinnerPlan { action: 'keep' | 'reprice' | 'stop'; price: number; floor: number; target: number; message: string; applied: boolean; listingStatus: string }

/** 아이템위너 대응: Wing 가격관리에서 본 위너 가격 입력 → 미리보기 → 적용 */
function WinnerPanel({ l, act, onChange }: { l: Listing; act: ReturnType<typeof useAction>; onChange: () => void }) {
  const [price, setPrice] = useState(l.winner_price ? String(l.winner_price) : '');
  const [plan, setPlan] = useState<WinnerPlan | null>(null);
  const call = (apply: boolean) => api.post<WinnerPlan>(`/api/listings/${l.id}/winner`, { winnerPrice: Number(price), apply });
  const label = { keep: '가격 유지', reprice: '가격 맞춤', stop: '판매종료' } as const;
  return (
    <div className="form">
      <div className="muted">
        아이템위너 대응 — 쿠팡 API로는 위너 여부를 알 수 없어 직접 확인이 필요합니다. Wing &gt; 상품관리 &gt; 가격관리에서 이 상품이 위너가 아니면,
        위너의 <b>판매가+배송비</b>를 입력하세요. 하한가({won(l.floor_price)}) 안에서 위너보다 10원 싸게 맞추고, 못 맞추면 판매종료합니다.
      </div>
      <div className="row">
        <label>위너 가격(판매가+배송비)<input inputMode="numeric" value={price} onChange={(e) => { setPrice(e.target.value.replace(/[^\d]/g, '')); setPlan(null); }} /></label>
        <button type="button" className="btn" disabled={act.busy || !Number(price)} onClick={() => void act.run(() => call(false).then(setPlan), '미리보기')}>미리보기</button>
        <button type="button" className="btn" disabled={act.busy} onClick={() => void act.run(() => api.post(`/api/listings/${l.id}/winner/ok`).then(onChange), '위너로 기록')}>위너 맞음</button>
      </div>
      {plan && (
        <div>
          <div className={plan.action === 'stop' ? 'item-reason' : ''}>[{label[plan.action]}] {plan.message}</div>
          {!plan.applied && (
            <button type="button" className={`btn ${plan.action === 'stop' ? '' : 'primary'}`} disabled={act.busy}
              onClick={() => void act.run(() => call(true).then((r) => { setPlan(r); onChange(); }), plan.action === 'stop' ? '판매종료함' : '적용됨')}>
              {plan.action === 'stop' ? '판매종료 적용' : '적용'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ListingEditor({ l, act, onChange }: { l: Listing; act: ReturnType<typeof useAction>; onChange: () => void }) {
  const [form, setForm] = useState({ title: l.title, salePrice: String(l.sale_price), categoryCode: l.category_code ?? '', tags: l.search_tags.join(', ') });
  const [images, setImages] = useState<string[]>(l.images);
  const editable = l.status === 'draft' || l.status === 'rejected';

  const upload = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      const r = await api.post<{ url: string }>('/api/media', f, f.type);
      setImages((x) => [...x, r.url]);
    }
  };

  return (
    <div className="editor">
      {editable ? (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void act.run(() => api.patch(`/api/listings/${l.id}`, {
              title: form.title, salePrice: Number(form.salePrice), images,
              categoryCode: form.categoryCode || undefined,
              tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
            }).then(onChange), '저장됨');
          }}
        >
          <label>상품명<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
          <div className="row">
            <label>판매가<input inputMode="numeric" value={form.salePrice} onChange={(e) => setForm({ ...form, salePrice: e.target.value })} /></label>
            <label>카테고리 코드<input value={form.categoryCode} placeholder="비우면 자동 추천" onChange={(e) => setForm({ ...form, categoryCode: e.target.value })} /></label>
          </div>
          <label>검색태그(쉼표 구분)<input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} /></label>
          <div>
            <div className="muted">이미지 {l.image_reuse_allowed ? '(공급처 이미지 사용 가능)' : '(직접 촬영·제작 이미지 필요)'} — 첫 번째가 대표, 정사각형 500px 이상·3MB 이하</div>
            <div className="thumbs">
              {images.map((u, i) => (
                <div key={u + i} className="thumb">
                  <img src={u} alt="" />
                  <button type="button" className="btn small" onClick={() => setImages(images.filter((_, j) => j !== i))}>삭제</button>
                </div>
              ))}
            </div>
            <input type="file" accept="image/jpeg,image/png" multiple onChange={(e) => void act.run(() => upload(e.target.files), '업로드됨')} />
          </div>
          <div className="row">
            <button className="btn" disabled={act.busy}>저장</button>
            <button type="button" className="btn primary" disabled={act.busy} onClick={() => void act.run(() => api.post(`/api/listings/${l.id}/register`).then(onChange), `쿠팡 등록 요청됨: ${l.title} (심사중 탭)`)}>쿠팡 등록</button>
          </div>
        </form>
      ) : (
        <div className="row">
          {l.status === 'active' && <button className="btn" disabled={act.busy} onClick={() => void act.run(() => api.post(`/api/listings/${l.id}/pause`).then(onChange), '판매중지')}>판매중지</button>}
          {(l.status === 'paused' || l.status === 'stopped') && <button className="btn primary" disabled={act.busy} onClick={() => void act.run(() => api.post(`/api/listings/${l.id}/resume`).then(onChange), '판매재개')}>판매재개</button>}
          <a className="btn" href={l.source_url} target="_blank" rel="noreferrer">공급처 보기</a>
        </div>
      )}
      {(l.status === 'active' || l.status === 'paused') && !l.dry_run && <WinnerPanel l={l} act={act} onChange={onChange} />}
      <div className="muted small">쿠팡 상품ID {l.seller_product_id ?? '-'} · 옵션ID {l.vendor_item_id ?? '-'} · 카테고리 {l.category_name ?? l.category_code ?? '-'} · 등록 {dt(l.listed_at)}</div>
    </div>
  );
}
