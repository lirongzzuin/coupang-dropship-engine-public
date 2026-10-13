import type { SourceAdapter } from '../ports/source.js';

/** 쿠팡을 공급처로 쓰는 경로는 정책상 금지(docs/architecture.md §7) */
const FORBIDDEN_SOURCE_IDS = ['coupang', 'wing', 'coupang-wing'];

/** 공급처 레지스트리: 새 공급처는 composition root(app.ts)에서 register 한 줄로 추가 */
export class SourceRegistry {
  private readonly map = new Map<string, SourceAdapter>();

  register(adapter: SourceAdapter): this {
    if (FORBIDDEN_SOURCE_IDS.includes(adapter.id.toLowerCase())) {
      throw new Error(`금지된 공급처: ${adapter.id} (쿠팡 구매품 재판매 금지)`);
    }
    this.map.set(adapter.id, adapter);
    return this;
  }

  get(id: string): SourceAdapter | undefined {
    return this.map.get(id);
  }

  require(id: string): SourceAdapter {
    const a = this.map.get(id);
    if (!a) throw new Error(`등록되지 않은 공급처: ${id}`);
    return a;
  }

  list(): SourceAdapter[] {
    return [...this.map.values()];
  }
}
