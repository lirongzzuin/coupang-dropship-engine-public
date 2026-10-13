import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import type { ObjectStorage } from '../../ports/misc.js';

/**
 * 로컬 디스크 저장소. 서버가 /media/<key> 로 공개 서빙한다(쿠팡이 vendorPath URL에서 이미지를 내려받음).
 * 운영 규모가 커지면 같은 인터페이스로 R2/S3 어댑터로 교체.
 */
export class LocalStorage implements ObjectStorage {
  constructor(
    private readonly dir: string,
    private readonly publicBase: string,
  ) {}

  private path(key: string): string {
    const safe = normalize(key).replace(/^(\.\.(\/|\\|$))+/, '');
    if (safe.includes('..') || safe.startsWith('/')) throw new Error('잘못된 키');
    return join(this.dir, safe);
  }

  async put(key: string, data: Buffer, contentType: string): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.path(key), data);
    await writeFile(`${this.path(key)}.type`, contentType);
    return this.publicUrl(key);
  }

  async get(key: string): Promise<{ data: Buffer; contentType: string } | null> {
    try {
      const data = await readFile(this.path(key));
      const contentType = await readFile(`${this.path(key)}.type`, 'utf8').catch(() => 'application/octet-stream');
      return { data, contentType };
    } catch {
      return null;
    }
  }

  publicUrl(key: string): string {
    return `${this.publicBase.replace(/\/$/, '')}/media/${encodeURIComponent(key)}`;
  }
}
