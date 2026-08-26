'use client';

import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { controlApiUrl, GulleyAdminApi } from './api';

interface AdminContextValue {
  token: string | null;
  setToken: (token: string | null) => void;
  api: GulleyAdminApi | null;
  /** True once the persisted token has been read on the client (avoids hydration flash). */
  ready: boolean;
}

const AdminContext = createContext<AdminContextValue | null>(null);
const TOKEN_KEY = 'gulley.admin.token';

export function AdminProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      setTokenState(sessionStorage.getItem(TOKEN_KEY));
    } catch {
      /* private mode / no storage */
    }
    setReady(true);
  }, []);

  const setToken = (next: string | null): void => {
    try {
      if (next) sessionStorage.setItem(TOKEN_KEY, next);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
    setTokenState(next);
  };

  const api = useMemo(() => (token ? new GulleyAdminApi(controlApiUrl(), token) : null), [token]);

  return (
    <AdminContext.Provider value={{ token, setToken, api, ready }}>
      {children}
    </AdminContext.Provider>
  );
}

export function useAdmin(): AdminContextValue {
  const ctx = useContext(AdminContext);
  if (!ctx) throw new Error('useAdmin must be used within an AdminProvider');
  return ctx;
}
