"use client";

import type { Materials } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";

export const MATERIAL_META: Record<string, { emoji: string; name: string }> = {
  wood: { emoji: "🪵", name: "木材" },
  coin: { emoji: "🪙", name: "金币" },
  gem: { emoji: "💎", name: "宝石" },
  seed: { emoji: "🌱", name: "种子" },
};

export function MaterialBar({
  materials,
  className,
  compact,
}: {
  materials: Materials | Record<string, number> | null | undefined;
  className?: string;
  compact?: boolean;
}) {
  if (!materials) return null;
  return (
    <ul
      className={cn("flex flex-wrap items-center gap-2", compact && "gap-1.5", className)}
      aria-label="我的材料"
    >
      {Object.entries(materials).map(([code, count]) => {
        const meta = MATERIAL_META[code] ?? { emoji: "❔", name: code };
        return (
          <li
            key={code}
            className={cn(
              "flex items-center gap-1.5 rounded-pill bg-white px-3 py-1.5 shadow-kid-sm",
              compact && "px-2 py-1 text-base",
            )}
          >
            <span className="text-kid-lg" aria-hidden>
              {meta.emoji}
            </span>
            <span className="font-bold tabular-nums">{count}</span>
            <span className="sr-only">{meta.name}</span>
          </li>
        );
      })}
    </ul>
  );
}
