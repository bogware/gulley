'use client';

import { useEffect, useRef, useState } from 'react';
import { useAdmin } from './admin-context';
import type { GulleyAdminApi } from './api';

export interface QueryResult<T> {
  data?: T;
  error?: string;
  loading: boolean;
  refetch: () => void;
}

/**
 * Run an admin API call and track loading/error/data. `deps` drive re-fetch;
 * `refetch()` forces one. The factory receives the authenticated client.
 */
export function useAdminQuery<T>(
  factory: (api: GulleyAdminApi) => Promise<T>,
  deps: unknown[] = [],
): QueryResult<T> {
  const { api } = useAdmin();
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const factoryRef = useRef(factory);
  factoryRef.current = factory;

  useEffect(() => {
    if (!api) {
      setLoading(false);
      setError('Not connected — paste an admin token.');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    factoryRef
      .current(api)
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, nonce, ...deps]);

  return { data, error, loading, refetch: () => setNonce((n) => n + 1) };
}
