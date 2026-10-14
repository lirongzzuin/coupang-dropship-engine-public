import type { AppContext } from '../../context.js';
import { audit } from '../../context.js';
import type { ListingRow } from '../../db/schema.js';
import { errMessage, truncate } from '../../lib/util.js';
import type { CategoryMeta } from '../../ports/market.js';
import { upsertSourceProduct } from '../catalog.js';
import { getHalt } from '../guard/safety.js';
import { PAUSE, pauseKind, pauseListing, resumeListing } from '../listing/control.js';
import { getItems } from '../listing/items.js';
import { buildAttributes } from '../listing/payload.js';
import { productNameFor } from '../listing/text.js';
import { supplyProblem } from '../sync/service.js';

/**
 * 상품 설정 자동 점검·수정(스케줄러, 60분).
 * 쿠팡에 올라간 상품(승인완료)을 쿠팡 상품 조회로 읽어, 공급처 옵션 기준의 올바른 값과 비교한다.
 *  - 구매옵션(색상·사이즈·수량 등): 판매 옵션(고정 옵션)에서 다시 계산(variant.ts) — 예: 멀티/FREE → 화이트/3호
 *  - 노출상품명: 구매옵션 값과 겹치는 단어 제거(쿠팡 "상품명에서 옵션과 중복된 단어를 지워주세요")
 *  - 옵션 여러 개인 공급처 상품인데 판매 옵션이 정해지지 않았으면 기본 옵션을 정함
 * 다르면 쿠팡 상품 수정(승인필요)으로 고친다: 조회한 JSON 전문에서 해당 값만 바꿔 전송(쿠팡 공식 방식) → 재심사.
 * 승인 후 다시 점검해 맞으면 완료. 설정 오류로 멈춘 상품(직접 중지·쿠팡에서 중지·옵션 미지정)은 공급처가 판매 가능할 때 자동 재개.
 * 오류가 없는 직접 중지 상품은 그대로 둔다(사람이 다른 이유로 멈췄을 수 있음).
 * 직접 연결한 상품(Wing에서 직접 등록)은 사람이 정한 설정이라 고치지 않는다.
 */

/** 사람이 강제로 멈춤 — 자동으로는 절대 재개하지 않음(관리 화면 [판매재개] → 검토 후 재개만) */
export const FORCE_STOP = '관리자 중지(강제)';
/** [판매재개]를 누른 상품: 설정 점검(필요하면 쿠팡 수정·승인) → 공급처 확인 → 재개 */
export const REVIEWING = '재개 검토중';
/** 재개 보류: 점검에서 고칠 수 없는 문제가 나옴(사람이 확인) */
export const HELD = '재개 보류';

/** 설정 점검·수정이 끝나면 판매를 재개해도 되는 중지 사유(시스템이 멈춘 옵션 미지정, 사람이 재개를 요청한 상품) */
const RESUMABLE = [PAUSE.optionUnset, REVIEWING];
const resumable = (reason: string | null) => !!reason && RESUMABLE.some((p) => reason.startsWith(p));
const norm = (v: unknown) => String(v ?? '').replace(/\s+/g, '').toLowerCase();

export interface AuditResult {
  /** 사람이 읽을 변경 내용(빈 배열 = 쿠팡 설정 정상) */
  changes: string[];
  /** 쿠팡에 보낼 수정 JSON(바꿀 게 없으면 없음) */
  body?: Record<string, any>;
  name?: string;
  /** 판매 옵션(새로 정했으면 그 값) */
  pin?: string | null;
  /** 고칠 수 없는 사유(옵션 정보 부족 등) */
  unfixable?: string;
  /** 쿠팡 심사 중 등 지금은 점검하지 않음 */
  skip?: string;
}

export async function auditListing(ctx: AppContext, l: ListingRow, metaCache = new Map<string, CategoryMeta>()): Promise<AuditResult> {
  const detail = await ctx.market.getProductDetail!(l.seller_product_id!);
  if (!detail) return { changes: [], skip: '쿠팡 상품 조회 불가' };
  if (detail.statusName !== '승인완료') return { changes: [], skip: `쿠팡 상태 ${detail.statusName ?? '?'}` };
  const sp = await ctx.db.selectFrom('source_products').selectAll().where('id', '=', l.source_product_id).executeTakeFirstOrThrow();
  const src = ctx.sources.get(sp.source);
  if (!src?.capabilities.detail) return { changes: [], skip: '공급처 조회 불가' };
  const d = await src.getProduct(sp.source_item_id, { title: sp.title, ...(l.source_option ? { option: l.source_option } : {}) });
  if (!d) return { changes: [], skip: '공급처에 상품 없음(동기화가 처리)' };
  if (l.source_option) await upsertSourceProduct(ctx, sp.source, d);
  const changes: string[] = [];
  let pin = l.source_option;
  if (!pin && (d.options ?? []).filter((o) => o.name).length > 1) {
    if (!d.defaultOption) return { changes: [], unfixable: '판매할 공급처 옵션을 정할 수 없음(재고 있는 옵션 없음)' };
    pin = d.defaultOption;
    changes.push(`판매 옵션 지정: ${pin}`);
  }
  const source = pin ? { ...d, defaultOption: pin } : d;
  const code = String(detail.displayCategoryCode ?? l.category_code ?? '');
  let meta = metaCache.get(code);
  if (!meta) {
    meta = await ctx.market.getCategoryMeta(code);
    metaCache.set(code, meta);
  }
  const unitsByVid = new Map((await getItems(ctx, l)).filter((i) => i.vendor_item_id).map((i) => [String(i.vendor_item_id), i.unit_qty]));
  const body: Record<string, any> = structuredClone(detail);
  const values: string[] = [];
  let touched = false;
  for (const it of body.items ?? []) {
    const units = unitsByVid.get(String(it.vendorItemId));
    if (units === undefined) continue; // 이 시스템이 관리하지 않는 옵션은 그대로
    let expected;
    try {
      expected = buildAttributes(meta, `${sp.title} ${pin ?? ''}`.trim(), units, source);
    } catch (e) {
      return { changes: [], unfixable: errMessage(e) };
    }
    const cur: Array<Record<string, any>> = Array.isArray(it.attributes) ? it.attributes : [];
    for (const e of expected) {
      values.push(e.attributeValueName);
      const c = cur.find((a) => a.attributeTypeName === e.attributeTypeName);
      if (c && norm(c.attributeValueName) === norm(e.attributeValueName)) continue;
      changes.push(`${units}개 옵션 ${e.attributeTypeName}: ${c?.attributeValueName || '(없음)'} → ${e.attributeValueName}`);
      if (c) c.attributeValueName = e.attributeValueName;
      else cur.push({ attributeTypeName: e.attributeTypeName, attributeValueName: e.attributeValueName });
      touched = true;
    }
    // 값 없는 선택 속성은 보내지 않음(쿠팡: attributes 에서 빼면 미입력)
    it.attributes = cur.filter((a) => String(a.attributeValueName ?? '').trim() !== '');
  }
  const current = String(detail.displayProductName ?? '');
  const name = truncate(productNameFor(current, values), 100);
  if (current && name !== current) {
    changes.push(`상품명 옵션 단어 중복 제거: "${current}" → "${name}"`);
    body.displayProductName = name;
    body.sellerProductName = name;
    body.generalProductName = name;
    touched = true;
  }
  body.requested = true; // 저장과 함께 승인 요청
  return { changes, ...(touched ? { body } : {}), name: touched ? name : current, pin };
}

export interface RepairResult {
  checked: number;
  requested: number;
  completed: number;
  resumed: number;
  failed: number;
  unfixable: number;
  errors: number;
}

export async function repairListings(ctx: AppContext): Promise<RepairResult> {
  const s = await ctx.settings.get();
  const out: RepairResult = { checked: 0, requested: 0, completed: 0, resumed: 0, failed: 0, unfixable: 0, errors: 0 };
  if (s.killSwitch || !s.repair.enabled || !ctx.market.getProductDetail || !ctx.market.updateProduct) return out;
  const now = ctx.clock.now();
  const rows = await ctx.db.selectFrom('listings').selectAll().where('dry_run', '=', false).where('seller_product_id', 'is not', null)
    .where('status', 'in', ['active', 'paused'])
    .where((eb) => eb.or([eb('candidate_id', 'is not', null), eb('payload', 'is not', null)]))
    .orderBy('id').execute();
  const metaCache = new Map<string, CategoryMeta>();
  const requested: string[] = [], completed: string[] = [], resumedT: string[] = [], failed: string[] = [], unfixable: string[] = [];
  for (const l of rows) {
    try {
      if (l.repair_state === 'requested') {
        await followUp(ctx, l, metaCache, { completed, resumedT, failed, out });
        continue;
      }
      if (l.repair_state === 'failed' && (l.repair_attempts >= s.repair.maxAttempts
        || (l.repair_requested_at && now.getTime() - new Date(l.repair_requested_at).getTime() < s.repair.retryHours * 3600_000))) continue;
      out.checked++;
      const a = await auditListing(ctx, l, metaCache);
      if (a.skip) continue;
      if (a.unfixable) {
        out.unfixable++;
        await hold(ctx, l, a.unfixable);
        if (l.repair_note !== a.unfixable) {
          await ctx.db.updateTable('listings').set({ repair_note: a.unfixable.slice(0, 500) }).where('id', '=', l.id).execute();
          unfixable.push(`• ${l.title.slice(0, 26)} — ${a.unfixable.slice(0, 80)}`);
        }
        continue;
      }
      if (!a.body) {
        // 쿠팡 설정은 정상. 판매 옵션만 새로 정했으면 기록하고, 옵션 미지정으로 멈춘 상품은 재개
        if (a.pin && a.pin !== l.source_option) await ctx.db.updateTable('listings').set({ source_option: a.pin }).where('id', '=', l.id).execute();
        if (l.repair_note) await ctx.db.updateTable('listings').set({ repair_note: null }).where('id', '=', l.id).execute();
        if (l.status === 'paused' && resumable(l.status_reason)) {
          if (await tryResume(ctx, { ...l, source_option: a.pin ?? l.source_option })) {
            out.resumed++;
            resumedT.push(`• ${l.title.slice(0, 26)}`);
          }
        }
        continue;
      }
      if (out.requested >= s.repair.perRun) continue; // 나머지는 다음 실행
      const r = await requestFix(ctx, l, a);
      if (r.ok) {
        out.requested++;
        requested.push(`• ${l.title.slice(0, 26)}\n  ${a.changes.join('\n  ')}`);
      } else {
        out.failed++;
        failed.push(`• ${l.title.slice(0, 26)} — ${r.message.slice(0, 120)}`);
      }
    } catch (e) {
      out.errors++;
      ctx.log.warn({ listing: l.id, err: errMessage(e) }, '상품 설정 점검 실패');
    }
  }
  const n = ctx.notifications;
  if (requested.length) await n.notify('info', `상품 설정 자동 수정 요청 ${requested.length}개(쿠팡 심사 중)`, `${requested.slice(0, 6).join('\n')}\n쿠팡 승인 후 다시 확인하고, 설정 오류로 멈춘 상품은 자동으로 판매를 재개합니다.`, { path: '/listings' });
  if (completed.length) await n.notify('info', `상품 설정 수정 완료 ${completed.length}개`, completed.slice(0, 8).join('\n'), { path: '/listings' });
  if (resumedT.length) await n.notify('info', `설정 수정 확인 → 판매 재개 ${resumedT.length}개`, resumedT.slice(0, 8).join('\n'), { path: '/listings' });
  if (failed.length) await n.notify('error', `상품 설정 수정 실패 ${failed.length}개`, `${failed.slice(0, 6).join('\n')}\n${s.repair.retryHours}시간 뒤 다시 시도합니다(최대 ${s.repair.maxAttempts}회). 계속 실패하면 Wing 상품관리에서 직접 수정하세요.`, { path: '/listings' });
  if (unfixable.length) await n.notify('warn', `자동으로 고칠 수 없는 상품 ${unfixable.length}개`, `${unfixable.slice(0, 6).join('\n')}\n판매중이면 그대로 두고, 멈춘 상품은 멈춘 채로 둡니다. Wing에서 직접 수정하거나 상품을 정리하세요.`, { path: '/listings' });
  return out;
}

/** 수정 요청한 상품: 쿠팡 승인 여부 확인 → 승인되면 다시 점검해 맞으면 완료(+재개), 반려면 실패 */
async function followUp(ctx: AppContext, l: ListingRow, metaCache: Map<string, CategoryMeta>, acc: { completed: string[]; resumedT: string[]; failed: string[]; out: RepairResult }): Promise<void> {
  const s = await ctx.settings.get();
  const now = ctx.clock.now();
  const detail = await ctx.market.getProductDetail!(l.seller_product_id!);
  const status = String(detail?.statusName ?? '');
  if (status === '승인완료') {
    const a = await auditListing(ctx, l, metaCache);
    if (a.body || a.unfixable) {
      const why = a.unfixable ?? `승인 후에도 값이 다름: ${a.changes.join(', ')}`;
      await ctx.db.updateTable('listings').set({ repair_state: 'failed', repair_note: why.slice(0, 1000), updated_at: now }).where('id', '=', l.id).execute();
      await hold(ctx, l, why);
      acc.out.failed++;
      acc.failed.push(`• ${l.title.slice(0, 26)} — ${why.slice(0, 120)}`);
      return;
    }
    await ctx.db.updateTable('listings').set({ repair_state: null, repair_note: `수정 완료(쿠팡 승인) — ${l.repair_note ?? ''}`.slice(0, 1000), updated_at: now }).where('id', '=', l.id).execute();
    acc.out.completed++;
    acc.completed.push(`• ${l.title.slice(0, 26)}`);
    if (l.repair_resume && l.status === 'paused' && (await tryResume(ctx, l))) {
      acc.out.resumed++;
      acc.resumedT.push(`• ${l.title.slice(0, 26)}`);
    }
    return;
  }
  if (status === '승인반려') {
    await ctx.db.updateTable('listings').set({ repair_state: 'failed', repair_note: '쿠팡이 수정을 반려 — Wing 상품관리에서 반려 사유 확인', updated_at: now }).where('id', '=', l.id).execute();
    await hold(ctx, l, '쿠팡이 수정을 반려(Wing 상품관리에서 사유 확인)');
    acc.out.failed++;
    acc.failed.push(`• ${l.title.slice(0, 26)} — 쿠팡 승인 반려(Wing에서 사유 확인)`);
    return;
  }
  if (l.repair_requested_at && now.getTime() - new Date(l.repair_requested_at).getTime() > s.repair.reviewAlertHours * 3600_000) {
    await ctx.notifications.notify('warn', '상품 수정 심사가 오래 걸림', `${l.title.slice(0, 30)}: ${s.repair.reviewAlertHours}시간 넘게 쿠팡 심사 중(${status || '상태 확인 불가'}). Wing 상품관리에서 확인하세요.`,
      { path: '/listings', dedupeKey: `repair-review-${l.id}`, dedupeMinutes: 24 * 60 });
  }
}

/** 공급처가 지금 판매 가능할 때만 재개. 공급처 문제가 있으면 그 사유로 바꿔 두어 동기화가 회복 시 재개 */
async function tryResume(ctx: AppContext, l: ListingRow): Promise<boolean> {
  const s = await ctx.settings.get();
  if (s.killSwitch || (await getHalt(ctx))) return false;
  const sp = await ctx.db.selectFrom('source_products').selectAll().where('id', '=', l.source_product_id).executeTakeFirstOrThrow();
  const src = ctx.sources.get(sp.source);
  const d = src ? await src.getProduct(sp.source_item_id, { title: sp.title, ...(l.source_option ? { option: l.source_option } : {}) }) : null;
  const problem = supplyProblem(s, d);
  const fresh = await ctx.db.selectFrom('listings').selectAll().where('id', '=', l.id).executeTakeFirstOrThrow();
  if (problem) {
    await ctx.db.updateTable('listings').set({ status_reason: problem.slice(0, 300), repair_resume: false }).where('id', '=', l.id).execute();
    return false;
  }
  if (pauseKind(fresh.status_reason) !== 'other' || fresh.status !== 'paused') return false;
  const ok = await resumeListing(ctx, fresh);
  if (ok) await ctx.db.updateTable('listings').set({ repair_resume: false }).where('id', '=', l.id).execute();
  return ok;
}

/** 점검 결과(a.body)로 쿠팡 상품 수정 요청. 성공하면 심사 대기(requested), 실패면 failed + (재개 검토 중이면) 재개 보류 */
async function requestFix(ctx: AppContext, l: ListingRow, a: AuditResult): Promise<{ ok: boolean; message: string }> {
  const now = ctx.clock.now();
  const r = await ctx.market.updateProduct!(a.body!);
  const fields = {
    repair_requested_at: now,
    repair_attempts: l.repair_attempts + 1,
    repair_note: (r.ok ? a.changes.join('\n') : `수정 요청 실패: ${r.message}`).slice(0, 1000),
  };
  if (!r.ok) {
    await ctx.db.updateTable('listings').set({ ...fields, repair_state: 'failed', updated_at: now }).where('id', '=', l.id).execute();
    await hold(ctx, l, `쿠팡 수정 요청 실패(${r.message.slice(0, 80)})`);
    return { ok: false, message: r.message };
  }
  const p = (typeof l.payload === 'string' ? JSON.parse(l.payload) : l.payload) as Record<string, unknown> | null;
  await ctx.db.updateTable('listings').set({
    ...fields,
    repair_state: 'requested',
    repair_resume: l.status === 'paused' && resumable(l.status_reason),
    source_option: a.pin ?? l.source_option,
    title: a.name ?? l.title,
    ...(p ? { payload: JSON.stringify({ ...p, displayProductName: a.name, sellerProductName: a.name, generalProductName: a.name }) } : {}),
    updated_at: now,
  }).where('id', '=', l.id).execute();
  await audit(ctx, 'repair', 'listing.repair_requested', String(l.id), { changes: a.changes, dryRun: !!r.dryRun });
  return { ok: true, message: a.changes.join(' / ') };
}

/** 재개 검토 중인 상품이 점검에서 막힘 → '재개 보류: 사유'(사람 확인, 자동 재개 안 함) */
async function hold(ctx: AppContext, l: ListingRow, why: string): Promise<void> {
  if (l.status !== 'paused' || !l.status_reason?.startsWith(REVIEWING)) return;
  await ctx.db.updateTable('listings').set({ status_reason: `${HELD}: ${why}`.slice(0, 300), repair_resume: false, updated_at: ctx.clock.now() }).where('id', '=', l.id).execute();
  await ctx.notifications.notify('warn', '판매 재개 보류', `${l.title.slice(0, 30)}: ${why.slice(0, 200)}\nWing 상품관리에서 직접 확인하거나 상품을 정리하세요. 고친 뒤 다시 [판매재개]를 누르면 다시 점검합니다.`, { path: '/listings' });
}

/**
 * [강제 판매중지]: 쿠팡 판매중지 + 어떤 자동 처리도 재개하지 않음(동기화·점검·대조 모두). 진행 중인 자동 재개 예약도 취소.
 * 다시 팔려면 [판매재개](검토 후 재개).
 */
export async function forceStop(ctx: AppContext, id: number, actor: string): Promise<ListingRow> {
  const l = await ctx.db.selectFrom('listings').selectAll().where('id', '=', id).executeTakeFirst();
  if (!l) throw Object.assign(new Error('등록 상품 없음'), { statusCode: 404 });
  if (!['active', 'paused'].includes(l.status)) throw Object.assign(new Error('판매중·일시중지 상품만 강제 중지할 수 있습니다'), { statusCode: 400 });
  if (l.status === 'active' && !(await pauseListing(ctx, l, FORCE_STOP))) {
    throw Object.assign(new Error('쿠팡 판매중지 실패 — 잠시 후 다시 시도하거나 Wing에서 중지하세요'), { statusCode: 502 });
  }
  const now = ctx.clock.now();
  // 이미 멈춘 상품도 강제 중지로(자동 재개 예약 취소). 쿠팡에서 판매중이면 대조가 다시 멈춤
  await ctx.db.updateTable('listings').set({ status_reason: FORCE_STOP, repair_resume: false, paused_at: l.paused_at ?? now, updated_at: now }).where('id', '=', id).execute();
  await audit(ctx, actor, 'listing.force_stop', String(id), { from: l.status, reason: l.status_reason });
  return ctx.db.selectFrom('listings').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}

export interface ResumeRequestResult {
  /** resumed: 바로 재개 / reviewing: 쿠팡 수정 심사·공급처 회복 등 기다리는 중(끝나면 자동 재개) / held: 재개 보류(사유 확인) */
  state: 'resumed' | 'reviewing' | 'held';
  message: string;
}

/**
 * [판매재개]: 바로 재개하지 않고 검토 단계를 거친다.
 *  1) 설정 점검(구매옵션·상품명·판매 옵션) — 오류가 있으면 쿠팡 수정 요청 → 승인 후 다시 점검(스케줄러) → 재개
 *  2) 공급처 판매 가능 확인 — 품절이면 공급처 사유로 두고 재입고 시 동기화가 재개
 *  3) 고칠 수 없으면 '재개 보류: 사유'
 * 직접 연결한 상품·모의 등록분은 설정 점검 없이 공급처 확인만.
 */
export async function requestResume(ctx: AppContext, id: number, actor: string): Promise<ResumeRequestResult> {
  const s = await ctx.settings.get();
  let l = await ctx.db.selectFrom('listings').selectAll().where('id', '=', id).executeTakeFirst();
  if (!l) throw Object.assign(new Error('등록 상품 없음'), { statusCode: 404 });
  if (l.status === 'active') return { state: 'resumed', message: '이미 판매중입니다' };
  if (!['paused', 'stopped'].includes(l.status)) throw Object.assign(new Error('일시중지·판매종료 상품만 재개할 수 있습니다'), { statusCode: 400 });
  if (l.status_reason?.startsWith(PAUSE.deleted)) throw Object.assign(new Error('쿠팡에서 삭제된 상품입니다'), { statusCode: 400 });
  if (s.killSwitch) throw Object.assign(new Error('긴급 정지 중입니다'), { statusCode: 400 });
  if (await getHalt(ctx)) throw Object.assign(new Error('안전장치 판매 중지 중입니다(먼저 홈의 [판매 재개]로 안전장치 해제)'), { statusCode: 400 });
  const now = ctx.clock.now();
  await ctx.db.updateTable('listings').set({ status: 'paused', status_reason: `${REVIEWING}: 설정·공급처 점검 중`, repair_resume: true, paused_at: l.paused_at ?? now, updated_at: now }).where('id', '=', id).execute();
  await audit(ctx, actor, 'listing.resume_requested', String(id), { from: l.status, reason: l.status_reason });
  l = await ctx.db.selectFrom('listings').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const auditable = !l.dry_run && !!l.seller_product_id && (l.candidate_id !== null || l.payload !== null) && !!ctx.market.getProductDetail && !!ctx.market.updateProduct && s.repair.enabled;
  if (auditable) {
    if (l.repair_state === 'requested') {
      await ctx.db.updateTable('listings').set({ status_reason: `${REVIEWING}: 쿠팡 수정 심사 대기` }).where('id', '=', id).execute();
      return { state: 'reviewing', message: '쿠팡이 설정 수정을 심사 중입니다. 승인되면 다시 점검하고 자동으로 재개합니다.' };
    }
    let a: AuditResult;
    try {
      a = await auditListing(ctx, l);
    } catch (e) {
      return { state: 'reviewing', message: `점검을 끝내지 못했습니다(${errMessage(e).slice(0, 80)}). 1시간 안에 다시 점검해 재개합니다.` };
    }
    if (a.skip) return { state: 'reviewing', message: `지금은 점검할 수 없습니다(${a.skip}). 1시간 안에 다시 점검해 재개합니다.` };
    if (a.unfixable) {
      await hold(ctx, l, a.unfixable);
      return { state: 'held', message: `재개 보류: ${a.unfixable}` };
    }
    if (a.body) {
      const r = await requestFix(ctx, l, a);
      if (!r.ok) return { state: 'held', message: `재개 보류: 쿠팡 수정 요청 실패(${r.message.slice(0, 80)})` };
      await ctx.db.updateTable('listings').set({ status_reason: `${REVIEWING}: 쿠팡 수정 심사 대기` }).where('id', '=', id).execute();
      return { state: 'reviewing', message: `설정 오류를 찾아 쿠팡에 수정을 요청했습니다(${a.changes.join(' / ').slice(0, 150)}). 승인되면 다시 점검하고 자동으로 재개합니다.` };
    }
    if (a.pin && a.pin !== l.source_option) await ctx.db.updateTable('listings').set({ source_option: a.pin }).where('id', '=', id).execute();
    l = await ctx.db.selectFrom('listings').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  }
  if (await tryResume(ctx, l)) return { state: 'resumed', message: auditable ? '설정 점검 정상 · 공급처 판매 가능 → 판매를 재개했습니다' : '공급처 판매 가능 → 판매를 재개했습니다' };
  const after = await ctx.db.selectFrom('listings').select(['status_reason']).where('id', '=', id).executeTakeFirstOrThrow();
  if (pauseKind(after.status_reason) === 'supply') return { state: 'reviewing', message: `${after.status_reason} — 공급처가 회복되면 자동으로 재개합니다` };
  return { state: 'reviewing', message: '쿠팡 판매 재개에 실패했습니다. 1시간 안에 다시 점검해 재개합니다.' };
}
