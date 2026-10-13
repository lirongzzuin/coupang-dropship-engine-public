import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Card, Loading, Msg, useAction, useLoad } from '../ui';

type Settings = Record<string, any>;

/** 자주 바꾸는 값은 폼으로, 나머지는 섹션별 JSON 편집(서버가 스키마 검증) */
const QUICK: Array<{ path: string; label: string; type: 'number' | 'text' | 'select' | 'list' | 'percent'; options?: string[]; help?: string }> = [
  { path: 'orders.mode', label: '발주 모드', type: 'select', options: ['auto', 'approve'], help: 'auto: API 가능한 공급처는 자동 발주' },
  { path: 'selection.mode', label: '선정 모드', type: 'select', options: ['auto', 'manual_approve'], help: 'auto: 조건 통과 상품 자동 등록' },
  { path: 'selection.keywordMode', label: '키워드 모드', type: 'select', options: ['auto', 'manual'], help: 'auto: API 데이터로 키워드 자동 발굴·순환(후보 > 키워드 풀)' },
  { path: 'discovery.allowTopCategories', label: '발굴 대상 대분류(줄바꿈, 도매꾹 분류명)', type: 'list', help: '기본: 인증·허가가 필요 없는 분류만' },
  { path: 'discovery.keywordsPerRun', label: '선정 1회당 키워드 수', type: 'number' },
  { path: 'selection.seedKeywords', label: '고정 키워드(줄바꿈, 선택)', type: 'list', help: '항상 함께 쓸 키워드. 비워도 자동 발굴로 동작' },
  { path: 'selection.autoListPerRun', label: '1회 자동 등록 최대 수', type: 'number' },
  { path: 'listing.maxActiveListings', label: '운영 상품 수 상한', type: 'number' },
  { path: 'pricing.minProfitKrw', label: '최소 순이익(원)', type: 'number' },
  { path: 'pricing.defaultMarkup', label: '시작 마크업(%) — 경쟁가 모를 때', type: 'percent' },
  { path: 'pricing.maxMarkup', label: '마크업 상한(%)', type: 'percent', help: '너무 높으면 경쟁 상품에 밀려 안 팔림' },
  { path: 'pricing.gapCapture', label: '경쟁가와의 차이 중 가져갈 비율(%)', type: 'percent', help: '50%면 하한가와 경쟁가의 중간 가격이 목표' },
  { path: 'pricing.launchDays', label: '출시 가격 유지 일수', type: 'number', help: '첫 판매·리뷰 확보를 위해 낮은 가격으로 시작' },
  { path: 'pricing.launchMarkup', label: '출시 마크업(%)', type: 'percent' },
  { path: 'selection.maxPrepDays', label: '최대 출고 준비일', type: 'number', help: '이보다 늦게 출고되는 상품은 제외' },
  { path: 'optimizer.enabled', label: '가격 자동 최적화', type: 'select', options: ['true', 'false'], help: '판매 결과로 매일 가격 조정' },
  { path: 'pricing.minMarginRate', label: '최소 순이익률(%)', type: 'percent' },
  { path: 'selection.minSupplyPrice', label: '공급가 하한(원)', type: 'number' },
  { path: 'orders.perOrderMaxCost', label: '건당 발주 상한(원)', type: 'number' },
  { path: 'orders.dailyMaxCost', label: '일 발주 상한(원)', type: 'number' },
  { path: 'coupang.keyIssuedAt', label: '쿠팡 API 키 발급일(YYYY-MM-DD)', type: 'text' },
  { path: 'coupang.vendorUserId', label: 'Wing 로그인 ID', type: 'text' },
  { path: 'coupang.outboundShippingPlaceCode', label: '출고지 코드', type: 'text' },
  { path: 'coupang.returnCenterCode', label: '반품지 코드', type: 'text' },
  { path: 'coupang.companyContactNumber', label: '고객센터 전화', type: 'text' },
  { path: 'coupang.returnChargeName', label: '반품지 담당자명', type: 'text' },
  { path: 'coupang.returnZipCode', label: '반품지 우편번호', type: 'text' },
  { path: 'coupang.returnAddress', label: '반품지 주소', type: 'text' },
  { path: 'coupang.returnAddressDetail', label: '반품지 상세주소', type: 'text' },
];

const get = (o: any, path: string) => path.split('.').reduce((a, k) => a?.[k], o);
const toPatch = (path: string, value: unknown) => path.split('.').reduceRight<any>((acc, k) => ({ [k]: acc }), value);

export function SettingsPage() {
  const { data, error, loading, reload } = useLoad<Settings>('/api/settings');
  const act = useAction();
  const [vals, setVals] = useState<Record<string, string>>({});
  const [section, setSection] = useState('fees');
  const [json, setJson] = useState('');

  useEffect(() => {
    if (!data) return;
    const v: Record<string, string> = {};
    for (const q of QUICK) {
      const x = get(data, q.path);
      v[q.path] = q.type === 'list' ? (x ?? []).join('\n') : q.type === 'percent' ? String(Math.round((x ?? 0) * 1000) / 10) : String(x ?? '');
    }
    setVals(v);
    setJson(JSON.stringify(data[section], null, 2));
  }, [data, section]);

  if (!data) return <Loading error={error} loading={loading} />;

  const saveQuick = () => act.run(async () => {
    let patch: any = {};
    for (const q of QUICK) {
      const raw = vals[q.path] ?? '';
      const v = q.type === 'number' ? Number(raw) : q.type === 'percent' ? Number(raw) / 100 : q.type === 'list' ? raw.split('\n').map((s) => s.trim()).filter(Boolean) : raw === 'true' ? true : raw === 'false' ? false : raw;
      patch = deepMerge(patch, toPatch(q.path, v));
    }
    await api.put('/api/settings', patch);
    reload();
  }, '저장됨');

  return (
    <div className="stack">
      <Card title="주요 설정">
        <form className="form" onSubmit={(e) => { e.preventDefault(); void saveQuick(); }}>
          {QUICK.map((q) => (
            <label key={q.path}>
              {q.label}
              {q.type === 'select' ? (
                <select value={vals[q.path] ?? ''} onChange={(e) => setVals({ ...vals, [q.path]: e.target.value })}>
                  {q.options!.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : q.type === 'list' ? (
                <textarea rows={4} value={vals[q.path] ?? ''} onChange={(e) => setVals({ ...vals, [q.path]: e.target.value })} />
              ) : (
                <input inputMode={q.type === 'text' ? 'text' : 'decimal'} value={vals[q.path] ?? ''} onChange={(e) => setVals({ ...vals, [q.path]: e.target.value })} />
              )}
              {q.help && <span className="muted small">{q.help}</span>}
            </label>
          ))}
          <button className="btn primary" disabled={act.busy}>저장</button>
        </form>
        <Msg msg={act.msg} />
      </Card>

      <Card title="고급 설정(JSON)">
        <p className="muted">수수료율·금지문구·택배사 별칭·스케줄 등. 출처·확인일은 docs/research.md 참고. 잘못된 값은 서버가 거부합니다.</p>
        <select value={section} onChange={(e) => setSection(e.target.value)}>
          {Object.keys(data).filter((k) => typeof data[k] === 'object').map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <textarea className="mono" rows={16} value={json} onChange={(e) => setJson(e.target.value)} />
        <button className="btn" disabled={act.busy} onClick={() => void act.run(async () => {
          const parsed = JSON.parse(json);
          // 배열 필드는 통째로 교체되므로 섹션 전체를 보냄
          await api.put('/api/settings', { [section]: parsed });
          reload();
        }, `${section} 저장됨`)}>이 섹션 저장</button>
      </Card>

      <Card title="기타">
        <div className="row">
          <Link className="btn" to="/jobs">작업·CSV·실행기록</Link>
        </div>
      </Card>
    </div>
  );
}

function deepMerge(a: any, b: any): any {
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return b;
  const out = { ...(a ?? {}) };
  for (const [k, v] of Object.entries(b)) out[k] = deepMerge(out[k], v);
  return out;
}
