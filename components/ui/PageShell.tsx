"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

/** 页面外壳：返回键 + 标题 + 右侧插槽。返回键可点区 ≥ 48px。 */
export function PageShell({
  title,
  emoji,
  backHref = "/",
  right,
  children,
  width = "kid",
  className,
}: {
  title: string;
  emoji?: string;
  backHref?: string;
  right?: ReactNode;
  children: ReactNode;
  /** kid = 儿童端宽屏留白；wide = 家长端信息密度 */
  width?: "kid" | "wide" | "full";
  className?: string;
}) {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-[#f0e6d6] bg-world-bg/95 backdrop-blur">
        <div
          className={cn(
            "mx-auto flex items-center gap-3 px-4 py-3",
            width === "wide" ? "max-w-6xl" : width === "full" ? "max-w-none" : "max-w-3xl",
          )}
        >
          <Link
            href={backHref}
            aria-label="回到数学世界"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white text-2xl shadow-kid-sm"
          >
            <span aria-hidden>←</span>
          </Link>
          <h1 className="flex min-w-0 items-center gap-2 text-kid-lg font-extrabold">
            {emoji ? <span aria-hidden>{emoji}</span> : null}
            <span className="truncate">{title}</span>
          </h1>
          <div className="ml-auto flex items-center gap-2">{right}</div>
        </div>
      </header>
      <main
        className={cn(
          "mx-auto px-4 py-5",
          width === "wide" ? "max-w-6xl" : width === "full" ? "max-w-none" : "max-w-3xl",
          className,
        )}
      >
        {children}
      </main>
    </div>
  );
}
