import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, refreshSession, setAccessToken, type Plan, type User } from './api';

interface SessionResponse {
  accessToken: string;
  user: User;
  plan: Plan;
}

interface AuthState {
  user: User | null;
  plan: Plan | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [ready, setReady] = useState(false);

  // The access token lives in memory only; the refresh cookie is httpOnly, so a
  // reload silently re-establishes the session without exposing a token to XSS.
  useEffect(() => {
    let cancelled = false;
    refreshSession()
      .then(async (token) => {
        if (cancelled || !token) return;
        const me = await api.get<{ user: User; plan: Plan }>('/auth/me');
        if (cancelled) return;
        setUser(me.user);
        setPlan(me.plan);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const adopt = useCallback((session: SessionResponse) => {
    setAccessToken(session.accessToken);
    setUser(session.user);
    setPlan(session.plan);
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      adopt(await api.post<SessionResponse>('/auth/login', { email, password }));
    },
    [adopt],
  );

  const register = useCallback(
    async (name: string, email: string, password: string) => {
      adopt(await api.post<SessionResponse>('/auth/register', { name, email, password }));
    },
    [adopt],
  );

  const logout = useCallback(async () => {
    await api.post('/auth/logout').catch(() => undefined);
    setAccessToken(null);
    setUser(null);
    setPlan(null);
  }, []);

  const refreshUser = useCallback(async () => {
    const me = await api.get<{ user: User; plan: Plan }>('/auth/me');
    setUser(me.user);
    setPlan(me.plan);
  }, []);

  const value = useMemo(
    () => ({ user, plan, ready, login, register, logout, refreshUser }),
    [user, plan, ready, login, register, logout, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
