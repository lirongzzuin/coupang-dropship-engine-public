import type { AppContext } from '../../context.js';

/**
 * Wing에 등록한 출고지·반품지 코드를 쿠팡 API로 읽어 설정의 빈 칸을 자동으로 채운다.
 * 사람이 이미 넣은 값은 덮어쓰지 않는다. 사용 가능한 곳이 여러 개면 첫 번째를 쓰고 알림으로 알려준다.
 */
export async function syncShippingPlaces(ctx: AppContext): Promise<{ filled: string[]; skipped?: string }> {
  if (!ctx.market.listShippingPlaces) return { filled: [], skipped: '판매채널이 지원하지 않음' };
  const s = await ctx.settings.get();
  const c = s.coupang;
  if (c.outboundShippingPlaceCode && c.returnCenterCode && c.returnZipCode && c.returnAddress && c.companyContactNumber) return { filled: [], skipped: '이미 설정됨' };
  const p = await ctx.market.listShippingPlaces();
  const ob = p.outbound.filter((x) => x.usable);
  const rc = p.returns.filter((x) => x.usable);
  const patch: Record<string, string> = {};
  if (!c.outboundShippingPlaceCode && ob[0]) patch.outboundShippingPlaceCode = ob[0].code;
  const r = rc.find((x) => x.code === c.returnCenterCode) ?? (!c.returnCenterCode ? rc[0] : undefined);
  if (r) {
    if (!c.returnCenterCode) patch.returnCenterCode = r.code;
    if (!c.returnChargeName) patch.returnChargeName = r.name;
    if (!c.returnZipCode && r.zip) patch.returnZipCode = r.zip;
    if (!c.returnAddress && r.address) patch.returnAddress = r.address;
    if (!c.returnAddressDetail && r.addressDetail) patch.returnAddressDetail = r.addressDetail;
    if (!c.companyContactNumber && r.phone) patch.companyContactNumber = r.phone;
  }
  const filled = Object.keys(patch);
  if (!filled.length) {
    if (!ob.length || !rc.length) {
      await ctx.notifications.notify('action', '쿠팡 출고지·반품지가 없어요', `Wing → 판매자정보 → 주소록에서 ${!ob.length ? '출고지' : ''}${!ob.length && !rc.length ? '·' : ''}${!rc.length ? '반품지' : ''}를 등록하면 자동으로 채워집니다.`, { path: '/settings' });
    }
    return { filled };
  }
  await ctx.settings.update({ coupang: patch });
  const many = ob.length > 1 || rc.length > 1 ? ` (등록된 곳이 여러 개라 첫 번째를 사용 — 바꾸려면 설정에서 수정)` : '';
  await ctx.notifications.notify('info', '쿠팡 출고지·반품지 자동 설정', `출고지 ${patch.outboundShippingPlaceCode ?? c.outboundShippingPlaceCode}, 반품지 ${patch.returnCenterCode ?? c.returnCenterCode}${many}`, { path: '/settings' });
  return { filled };
}
