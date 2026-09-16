"use client";

/**
 * dnd-kit 的薄封装。
 *
 * 儿童可用性上做了两件事：
 * 1. **拖拽 + 点一下都能移动**：很多孩子（尤其触屏）拖不准，
 *    所以每个可拖元素同时支持「点一下 → 送去下一个位置」。
 * 2. 拖拽结束后 250ms 内的点击会被忽略，避免「拖完又被当成点一下」。
 */

import { useCallback, useRef } from "react";
import type { ReactNode } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils/cn";

/** 防「拖拽手势被误判成点击」 */
export function useTapGuard() {
  const lastDropAt = useRef(0);
  const noteDrop = useCallback(() => {
    lastDropAt.current = Date.now();
  }, []);
  const canTap = useCallback(() => Date.now() - lastDropAt.current > 250, []);
  return { noteDrop, canTap };
}

export function DraggablePiece({
  id,
  disabled,
  onTap,
  canTap,
  className,
  children,
  label,
}: {
  id: string;
  disabled?: boolean;
  onTap?: () => void;
  /** 由 useTapGuard 提供：拖拽刚结束时抑制这次点击 */
  canTap?: () => boolean;
  className?: string;
  children: ReactNode;
  label: string;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id, disabled });

  return (
    <button
      ref={setNodeRef}
      type="button"
      aria-label={label}
      disabled={disabled}
      style={{ transform: CSS.Translate.toString(transform), zIndex: isDragging ? 40 : undefined }}
      className={cn(
        "touch-none select-none rounded-xl transition",
        isDragging && "scale-110 drop-shadow-lg",
        className,
      )}
      {...listeners}
      {...attributes}
      onClick={() => {
        if (disabled) return;
        if (!canTap || canTap()) onTap?.();
      }}
    >
      {children}
    </button>
  );
}

export function DropZone({
  id,
  className,
  children,
  label,
}: {
  id: string;
  className?: string;
  children: ReactNode;
  label: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      role="group"
      aria-label={label}
      className={cn(
        "rounded-2xl border-4 border-dashed p-2 transition-colors",
        isOver ? "border-world-grass bg-[#f2fbef]" : "border-[#d9cdb8] bg-white/70",
        className,
      )}
    >
      {children}
    </div>
  );
}
