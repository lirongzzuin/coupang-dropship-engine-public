import { afterEach, describe, expect, it } from 'vitest';
import { syncShippingPlaces } from '../src/modules/setup/coupangPlaces.js';
import { makeHarness, type TestHarness } from './helpers.js';

let h: TestHarness;
afterEach(async () => h && (await h.close()));

describe('쿠팡 출고지·반품지 자동 설정', () => {
  it('빈 칸만 쿠팡 API 값으로 채우고, 사람이 넣은 값은 유지', async () => {
    h = await makeHarness();
    await h.ctx.settings.update({ coupang: { companyContactNumber: '1588-0000' } });
    const r = await syncShippingPlaces(h.ctx);
    expect(r.filled).toEqual(expect.arrayContaining(['outboundShippingPlaceCode', 'returnCenterCode', 'returnZipCode', 'returnAddress']));
    const c = (await h.ctx.settings.get()).coupang;
    expect(c).toMatchObject({ outboundShippingPlaceCode: '10000001', returnCenterCode: '2000000001', returnZipCode: '04524', returnAddressDetail: '101호', companyContactNumber: '1588-0000' });
    expect((await syncShippingPlaces(h.ctx)).skipped).toBe('이미 설정됨');
  });

  it('Wing에 출고지·반품지가 없으면 등록 안내 알림', async () => {
    h = await makeHarness();
    (h.market as any).shippingPlaces = { outbound: [], returns: [] };
    expect((await syncShippingPlaces(h.ctx)).filled).toEqual([]);
    expect(h.notifier.sent.some((m: any) => m.title.includes('출고지'))).toBe(true);
  });
});
