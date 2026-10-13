import { useState } from 'react';
import { api, won } from '../api';
import { Card, CopyButton, Msg, useAction, useLoad } from '../ui';

interface Quote {
  source: string; sourceItemId: string; sourceUrl: string; status: string; stock: number | null; supplyPrice: number; shippingFee: number;
  minResalePrice: number | null; suggestedTitle: string; suggestedTags: string[]; salePrice: number | null;
  profit: { profit: number; margin: number; fee: number; feeVat: number } | null; images: string[]; imageReuseAllowed: boolean;
  options: Array<{ units: number; itemName: string; salePrice: number; floor: number; profit: number }>;
  prepDays: number; notice: { type?: string; items: Array<{ name: string; value: string }> } | null; apiOrder: boolean;
}
interface Meta { sources: Array<{ id: string; name: string; capabilities: { apiOrder: boolean } }> }

/**
 * 쿠팡 API 키가 없을 때(첫 상품) Wing에 직접 등록하도록 돕고, 등록된 쿠팡 상품을 공급처 상품과 연결한다.
 */
export function LinkTool({ onLinked }: { onLinked: () => void }) {
  const meta = useLoad<Meta>('/api/meta');
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState('');
  const [itemId, setItemId] = useState('');
  const [q, setQ] = useState<Quote | null>(null);
  const [link, setLink] = useState({ vendorItemId: '', sellerProductId: '', salePrice: '' });
  const act = useAction();
  const sources = meta.data?.sources ?? [];
  const src = source || sources[0]?.id || '';

  return (
    <Card title="쿠팡에 직접 등록한 상품 연결" right={<button className="btn small" onClick={() => setOpen(!open)}>{open ? '닫기' : '열기'}</button>}>
      {!open && <div className="muted small">API 키 발급 전 첫 상품을 Wing에서 직접 등록할 때, 상품 정보를 계산하고 등록 후 자동 관리에 연결합니다.</div>}
      {open && (
        <div className="form">
          {sources.length === 0 && <div className="msg err">사용 가능한 공급처가 없습니다. ~/dropship/.env 에 오너클랜(OWNERCLAN_USERNAME/PASSWORD) 또는 도매꾹 키를 넣고 앱을 재시작하세요.</div>}
          <b>1. 공급처 상품 견적</b>
          <div className="row">
            <label>공급처
              <select value={src} onChange={(e) => setSource(e.target.value)}>
                {sources.map((s) => <option key={s.id} value={s.id}>{s.name}{s.capabilities.apiOrder ? ' (자동 발주)' : ''}</option>)}
              </select>
            </label>
            <label>공급처 상품코드<input value={itemId} onChange={(e) => setItemId(e.target.value)} placeholder="예: W1234567" /></label>
          </div>
          <button className="btn" disabled={act.busy || !src || !itemId} onClick={() => void act.run(async () => {
            const r = await api.post<Quote>('/api/tools/quote', { source: src, sourceItemId: itemId });
            setQ(r);
            setLink((l) => ({ ...l, salePrice: r.salePrice ? String(r.salePrice) : '' }));
            return '견적 완료 — 아래 내용으로 Wing에 등록하세요';
          })}>견적 계산</button>

          {q && (
            <table className="kv">
              <tbody>
                <tr><th>상품명</th><td>{q.suggestedTitle} <CopyButton value={q.suggestedTitle} /></td></tr>
                <tr><th>권장 판매가</th><td><b>{won(q.salePrice)}</b> (무료배송) {q.salePrice && <CopyButton value={String(q.salePrice)} />}</td></tr>
                <tr><th>예상 이익</th><td>{won(q.profit?.profit)} ({q.profit ? Math.round(q.profit.margin * 100) : '-'}%)</td></tr>
                {q.options.length > 1 && <tr><th>묶음 옵션 권장</th><td className="small">{q.options.map((o) => `${o.units}개 ${won(o.salePrice)}(이익 ${won(o.profit)})`).join(' / ')}<div className="muted">Wing에서 옵션 "수량" 1개/2개/3개로 등록하면 객단가가 올라갑니다</div></td></tr>}
                <tr><th>공급가</th><td>{won(q.supplyPrice)} + 배송비 {won(q.shippingFee)}{q.minResalePrice ? ` · 최저판매준수가 ${won(q.minResalePrice)}` : ''}</td></tr>
                <tr><th>재고/상태</th><td>{q.stock ?? '?'} / {q.status}</td></tr>
                <tr><th>출고소요일</th><td>{q.prepDays}일</td></tr>
                <tr><th>검색태그</th><td>{q.suggestedTags.join(', ')} <CopyButton value={q.suggestedTags.join(',')} /></td></tr>
                <tr><th>이미지</th><td>{q.imageReuseAllowed ? q.images.map((u, i) => <div key={u}><a href={u} target="_blank" rel="noreferrer">이미지 {i + 1}</a></div>) : '공급처 이미지 사용 불가 — 직접 촬영 필요'}</td></tr>
                {q.notice?.items.length ? <tr><th>고시정보</th><td className="small">{q.notice.items.map((n) => `${n.name}: ${n.value}`).join(' / ')}</td></tr> : null}
                <tr><th>공급처 페이지</th><td><a href={q.sourceUrl} target="_blank" rel="noreferrer">열기</a></td></tr>
              </tbody>
            </table>
          )}

          <b>2. Wing에 등록한 뒤 연결</b>
          <div className="muted small">Wing &gt; 상품관리 &gt; 상품 조회/수정에서 등록상품ID와 옵션ID(vendorItemId)를 확인해 입력하세요. 승인 전이면 승인 후에 연결하세요.</div>
          <div className="row">
            <label>옵션ID(vendorItemId)<input inputMode="numeric" value={link.vendorItemId} onChange={(e) => setLink({ ...link, vendorItemId: e.target.value })} /></label>
            <label>등록상품ID(선택)<input inputMode="numeric" value={link.sellerProductId} onChange={(e) => setLink({ ...link, sellerProductId: e.target.value })} /></label>
            <label>실제 판매가<input inputMode="numeric" value={link.salePrice} onChange={(e) => setLink({ ...link, salePrice: e.target.value })} /></label>
          </div>
          <button className="btn primary" disabled={act.busy || !link.vendorItemId || !link.salePrice || !itemId} onClick={() => void act.run(async () => {
            const r = await api.post<{ listing: { id: number }; warning: string | null }>('/api/listings/link', {
              vendorItemId: link.vendorItemId, sellerProductId: link.sellerProductId || undefined, salePrice: Number(link.salePrice),
              source: src, sourceItemId: itemId, title: q?.suggestedTitle,
            });
            onLinked();
            return r.warning ? `연결됨(상품 #${r.listing.id}) — 주의: ${r.warning}` : `연결됨(상품 #${r.listing.id}) — 이제 주문이 자동 처리됩니다`;
          })}>연결하기</button>
          <Msg msg={act.msg} />
        </div>
      )}
    </Card>
  );
}
