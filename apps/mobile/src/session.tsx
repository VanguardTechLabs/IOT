import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import * as ApiClient from './api';
import { closeSocket } from './socket';

/**
 * Who is signed in.
 *
 * The app opens straight into a restore attempt rather than the login screen:
 * a keychain read plus one refresh call is fast, and showing a login form to
 * someone who is already signed in — every cold start — is the single most
 * irritating thing a phone app can do.
 */

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

interface SessionValue {
  user: SessionUser | null;
  plan: ApiClient.Plan | null;
  /** True until the stored session has been checked. Gates the first render. */
  restoring: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [plan, setPlan] = useState<ApiClient.Plan | null>(null);
  const [restoring, setRestoring] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const token = await ApiClient.refreshSession();
      if (cancelled) return;
      if (token) {
        try {
          const me = await ApiClient.api.get<{ user: SessionUser; plan: ApiClient.Plan }>('/auth/me');
          if (!cancelled) {
            setUser(me.user);
            setPlan(me.plan);
          }
        } catch {
          // The token refreshed but /me failed — almost always the network
          // dropping between the two calls. Land on the login screen rather
          // than a half-restored session showing empty lists.
          if (!cancelled) setUser(null);
        }
      }
      if (!cancelled) setRestoring(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const session = await ApiClient.login(email, password);
    setUser(session.user);
    setPlan(session.plan);
  }, []);

  const signOut = useCallback(async () => {
    closeSocket();
    await ApiClient.logout();
    setUser(null);
    setPlan(null);
  }, []);

  const value = useMemo(
    () => ({ user, plan, restoring, signIn, signOut }),
    [user, plan, restoring, signIn, signOut],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(Ctx);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
