"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 打字机效果。
 *
 * 注意节奏：默认 30ms/字，比成人阅读稍慢一点，让孩子跟得上；
 * 任何时刻点一下都能直接看完整句话（不强迫等待）。
 */
export function useTypewriter(text: string, speedMs = 30) {
  const [shown, setShown] = useState("");

  useEffect(() => {
    setShown("");
    if (!text) return;
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      setShown(text.slice(0, i));
      if (i >= text.length) clearInterval(timer);
    }, speedMs);
    return () => clearInterval(timer);
  }, [text, speedMs]);

  const finish = useCallback(() => setShown(text), [text]);
  const done = shown.length >= text.length;

  return { shown, done, finish };
}
