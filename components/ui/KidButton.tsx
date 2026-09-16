"use client";

import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

type Variant = "primary" | "sun" | "grass" | "ghost" | "quiet";
type Size = "md" | "lg" | "xl";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-world-sea text-white shadow-kid hover:brightness-[1.05]",
  sun: "bg-world-gold text-[#5c3d00] shadow-kid hover:brightness-[1.05]",
  grass: "bg-world-grass text-[#123d0a] shadow-kid hover:brightness-[1.05]",
  ghost: "bg-white text-world-ink shadow-kid-sm border-2 border-[#eee3d0]",
  quiet: "bg-[#efe7da] text-world-soft",
};

const SIZES: Record<Size, string> = {
  md: "min-h-[48px] px-5 text-kid rounded-pill",
  lg: "min-h-[56px] px-6 text-kid-lg rounded-pill",
  xl: "min-h-[64px] px-8 text-kid-xl rounded-pill",
};

export interface KidButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  block?: boolean;
}

/** 儿童端按钮：最小 44×44 可点区（实际最小 48px），键盘可聚焦 */
export const KidButton = forwardRef<HTMLButtonElement, KidButtonProps>(function KidButton(
  { variant = "primary", size = "lg", icon, block, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={rest.type ?? "button"}
      className={cn(
        "kid-btn select-none",
        VARIANTS[variant],
        SIZES[size],
        "disabled:opacity-60 disabled:shadow-none",
        block && "w-full",
        className,
      )}
      {...rest}
    >
      {icon ? <span aria-hidden>{icon}</span> : null}
      <span>{children}</span>
    </button>
  );
});
