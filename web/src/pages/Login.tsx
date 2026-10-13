import { useState } from 'react';
import { api } from '../api';
import { Msg, useAction } from '../ui';

export function Login({ setupRequired, onLogin }: { setupRequired: boolean; onLogin: () => void }) {
  const [form, setForm] = useState({ username: '', password: '', totp: '' });
  const { busy, msg, run } = useAction();
  return (
    <div className="login">
      <h1>쿠팡 위탁 운영</h1>
      {setupRequired ? (
        <div className="card">
          <p>관리자 계정이 없습니다. 서버에서 아래 명령으로 만든 뒤, 출력된 OTP 비밀키를 인증 앱(Google Authenticator 등)에 등록하세요.</p>
          <pre>pnpm --filter server admin:create 아이디 비밀번호</pre>
        </div>
      ) : (
        <form
          className="card form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.post('/api/auth/login', form).then(onLogin), '로그인');
          }}
        >
          <label>아이디<input autoComplete="username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
          <label>비밀번호<input type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
          <label>인증코드(OTP 6자리)<input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={form.totp} onChange={(e) => setForm({ ...form, totp: e.target.value })} /></label>
          <button className="btn primary" disabled={busy}>로그인</button>
          <Msg msg={msg} />
        </form>
      )}
    </div>
  );
}
