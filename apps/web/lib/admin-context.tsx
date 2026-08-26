'use client';

import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { controlApiUrl, GulleyAdminApi } from './api';

interface AdminContextValue {
  /** Authenticated via an OIDC session cookie or a pasted token. */
  authed: boolean;
  /** The pasted token, if any (OIDC uses an http-only cookie instead). */
  token: string | null;
  setToken: (token: string | null) => void;
  /** Always-present client (sends the cookie; adds a bearer when a token is set). */
  api: GulleyAdminApi;
  ready: boolean;
  refreshAuth: () => void;
}

const AdminContext = createContext<AdminContextValue | null>(null);
const TOKEN_KEY = 'gulley.admin.token';

export function AdminProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [cookieAuthed, setCookieAuthed] = useState(false);
  const [nonce, setNonce] = useState(0);

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
      .then(() => setCookieAuthed(true))
      .catch(() => setCookieAuthed(false))
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
      // Also clear any OIDC session cookie.
      void new GulleyAdminApi(controlApiUrl()).logout().catch(() => undefined);
      setCookieAuthed(false);
    }
    setTokenState(next);
  };

  const api = useMemo(() => new GulleyAdminApi(controlApiUrl(), token ?? undefined), [token]);
  const authed = Boolean(token) || cookieAuthed;

  return (
    <AdminContext.Provider
      value={{ authed, token, setToken, api, ready, refreshAuth: () => setNonce((n) => n + 1) }}
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
