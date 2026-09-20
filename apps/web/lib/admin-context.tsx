'use client';

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { controlApiUrl, GulleyAdminApi } from './api';

interface AdminContextValue {
  /** Authenticated via an OIDC session cookie or a pasted token — as VERIFIED by
   *  `/auth/me` (a stored token is not trusted until it answers). */
  authed: boolean;
  /** The pasted token, if any (OIDC uses an http-only cookie instead). */
  token: string | null;
  setToken: (token: string | null) => void;
  /** Always-present client (sends the cookie; adds a bearer when a token is set).
   *  A 401 from ANY call signs the console out (session expired / revoked). */
  api: GulleyAdminApi;
  ready: boolean;
  refreshAuth: () => void;
  /** Why the console is signed out, when it was signed out involuntarily. */
  authNotice: string | null;
}

const AdminContext = createContext<AdminContextValue | null>(null);
const TOKEN_KEY = 'gulley.admin.token';

export function AdminProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const clearStored = (): void => {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  };

  // Any 401 anywhere: the session is gone. Drop the stored token so a dead bearer
  // is not retried forever, and route back to sign-in with a reason.
  const onUnauthorized = useCallback((): void => {
    clearStored();
    setTokenState(null);
    setAuthed(false);
    setAuthNotice('Your session expired or was revoked — sign in again.');
  }, []);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = sessionStorage.getItem(TOKEN_KEY);
    } catch {
      /* no storage */
    }
    setTokenState(stored);
    new GulleyAdminApi(controlApiUrl(), stored ?? undefined)
      .me()
      .then(() => {
        setAuthed(true);
        setAuthNotice(null);
      })
      .catch(() => {
        // A stored token that no longer authenticates is dropped (not kept as "authed").
        if (stored) clearStored();
        setTokenState(null);
        setAuthed(false);
      })
      .finally(() => setReady(true));
  }, [nonce]);

  const setToken = (next: string | null): void => {
    try {
      if (next) sessionStorage.setItem(TOKEN_KEY, next);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
    if (!next) {
      // Also revoke + clear any OIDC session cookie.
      void new GulleyAdminApi(controlApiUrl()).logout().catch(() => undefined);
      setAuthed(false);
      setAuthNotice(null);
    }
    setTokenState(next);
  };

  const api = useMemo(
    () => new GulleyAdminApi(controlApiUrl(), token ?? undefined, { onUnauthorized }),
    [token, onUnauthorized],
  );

  return (
    <AdminContext.Provider
      value={{
        authed,
        token,
        setToken,
        api,
        ready,
        refreshAuth: () => setNonce((n) => n + 1),
        authNotice,
      }}
    >
      {children}
    </AdminContext.Provider>
  );
}

export function useAdmin(): AdminContextValue {
  const ctx = useContext(AdminContext);
  if (!ctx) throw new Error('useAdmin must be used within an AdminProvider');
  return ctx;
}
