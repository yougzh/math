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
 * 刻意不用构建期取数：没有后端时 `npm run build` 也必须成功，
 * 而且 mock 模式（NEXT_PUBLIC_USE_MOCK=1）只在运行时才有意义。
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
