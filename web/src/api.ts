/** 서버 API 클라이언트. 상태 변경 요청에는 CSRF 방어용 헤더를 붙인다. */
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown, contentType?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['x-requested-with'] = 'app';
  let payload: BodyInit | undefined;
  if (body instanceof Blob || typeof body === 'string') {
    payload = body;
    if (contentType) headers['content-type'] = contentType;
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth')) window.dispatchEvent(new Event('auth-expired'));
    throw new ApiError(res.status, (data && typeof data === 'object' && 'error' in data ? String(data.error) : res.statusText) || '오류');
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown, contentType?: string) => request<T>('POST', url, body ?? {}, contentType),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
};

export const won = (n: number | null | undefined) => (n === null || n === undefined ? '-' : `${Math.round(n).toLocaleString('ko-KR')}원`);
export const dt = (s: string | null | undefined) => (s ? new Date(s).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-');
