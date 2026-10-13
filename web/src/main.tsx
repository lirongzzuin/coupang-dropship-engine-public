import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom';
import { api } from './api';
import { Candidates } from './pages/Candidates';
import { Dashboard } from './pages/Dashboard';
import { Inquiries } from './pages/Inquiries';
import { Jobs } from './pages/Jobs';
import { Listings } from './pages/Listings';
import { Login } from './pages/Login';
import { OrderDetail } from './pages/OrderDetail';
import { Orders } from './pages/Orders';
import { SettingsPage } from './pages/Settings';
import './style.css';

type AuthState = { loading: boolean; user: { username: string } | null; setupRequired: boolean };

function App() {
  const [auth, setAuth] = useState<AuthState>({ loading: true, user: null, setupRequired: false });
  const check = () =>
    api.get<{ user: { username: string } | null; setupRequired: boolean }>('/api/auth/status')
      .then((r) => setAuth({ loading: false, ...r }))
      .catch(() => setAuth({ loading: false, user: null, setupRequired: false }));
  useEffect(() => {
    void check();
    const onExpire = () => setAuth((a) => ({ ...a, user: null }));
    window.addEventListener('auth-expired', onExpire);
    return () => window.removeEventListener('auth-expired', onExpire);
  }, []);

  if (auth.loading) return <div className="center muted">불러오는 중…</div>;
  if (!auth.user) return <Login setupRequired={auth.setupRequired} onLogin={check} />;

  return (
    <BrowserRouter>
      <header className="top">
        <strong>쿠팡 위탁 운영</strong>
        <button className="btn ghost small" onClick={() => api.post('/api/auth/logout').then(check)}>로그아웃</button>
      </header>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/orders/:id" element={<OrderDetail />} />
          <Route path="/listings" element={<Listings />} />
          <Route path="/candidates" element={<Candidates />} />
          <Route path="/inquiries" element={<Inquiries />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/jobs" element={<Jobs />} />
          <Route path="*" element={<Dashboard />} />
        </Routes>
      </main>
      <nav className="tabbar">
        <NavLink to="/" end>홈</NavLink>
        <NavLink to="/orders">주문</NavLink>
        <NavLink to="/listings">상품</NavLink>
        <NavLink to="/candidates">후보</NavLink>
        <NavLink to="/inquiries">문의</NavLink>
        <NavLink to="/settings">설정</NavLink>
      </nav>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
