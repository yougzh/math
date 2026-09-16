"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { describeError } from "@/lib/api/errors";

export interface ApiResource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * 客户端取数（所有页面都靠它）。
 *
 * 刻意不用构建期取数：没有数据库时 `npm run build` 也必须成功，
 * 页面数据全部在运行时从同源 /api/v1/* 拉取。
 */
export function useApiResource<T>(
  loader: () => Promise<T>,
  deps: ReadonlyArray<unknown> = [],
): ApiResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loaderRef
      .current()
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(describeError(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, error, loading, reload };
}
