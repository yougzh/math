"use client";

import { useMemo } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import type { GrowthTree as GrowthTreeData, GrowthNode } from "@/lib/api/types";

/**
 * 成长树。
 *
 * 全部用 SVG 画：节点位置直接取服务端的 `position.x / position.y`（契约 §9），
 * 连线取 `edges`。不做自动布局 —— 布局是内容侧的决定，前端不替它做主。
 */
export function GrowthTree({ tree }: { tree: GrowthTreeData }) {
  const layout = useMemo(() => {
    const nodes = tree.nodes ?? [];
    if (nodes.length === 0) return null;

    const colW = 190;
    const rowH = 150;
    const pad = 70;
    const xs = nodes.map((n) => n.position?.x ?? 0);
    const ys = nodes.map((n) => n.position?.y ?? 0);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);

    const width = (maxX - minX) * colW + pad * 2;
    const height = (maxY - minY) * rowH + pad * 2;

    const point = (n: GrowthNode) => ({
      x: pad + ((n.position?.x ?? 0) - minX) * colW,
      y: pad + ((n.position?.y ?? 0) - minY) * rowH,
    });

    const index = new Map(nodes.map((n) => [n.code, n]));
    const edges = (tree.edges ?? [])
      .map((e) => {
        const from = index.get(e.from);
        const to = index.get(e.to);
        if (!from || !to) return null;
        return { id: `${e.from}->${e.to}`, from: point(from), to: point(to), locked: !to.unlocked };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);

    return { nodes: nodes.map((n) => ({ node: n, ...point(n) })), edges, width, height };
  }, [tree]);

  if (!layout) {
    return (
      <div className="rounded-kid bg-white/70 p-6 text-center text-world-soft">
        成长树还在长，过几天再来看看。
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        className="h-auto w-full min-w-[520px]"
        role="img"
        aria-label="我的成长树"
      >
        <defs>
          <linearGradient id="nodeGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="100%" stopColor="#f7f1e6" />
          </linearGradient>
        </defs>

        {/* 连线 */}
        {layout.edges.map((e) => (
          <path
            key={e.id}
            d={`M ${e.from.x} ${e.from.y} C ${e.from.x} ${e.from.y + 50}, ${e.to.x} ${e.to.y - 50}, ${e.to.x} ${e.to.y}`}
            fill="none"
            stroke={e.locked ? "#e0d5c2" : "#c9bda8"}
            strokeWidth={e.locked ? 3 : 5}
            strokeDasharray={e.locked ? "8 8" : undefined}
            strokeLinecap="round"
          />
        ))}

        {/* 节点 */}
        {layout.nodes.map(({ node, x, y }, i) => {
          const locked = !node.unlocked;
          return (
            <motion.g
              key={node.code}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: i * 0.05, type: "spring", stiffness: 200, damping: 18 }}
              style={{ transformOrigin: `${x}px ${y}px` }}
            >
              <circle
                cx={x}
                cy={y}
                r={46}
                fill={locked ? "#efe9df" : "url(#nodeGrad)"}
                stroke={locked ? "#ddd2c0" : node.mastered ? "#f2b73a" : "#c9bda8"}
                strokeWidth={node.mastered ? 6 : 4}
              />
              <text x={x} y={y + 4} textAnchor="middle" fontSize={34} opacity={locked ? 0.5 : 1}>
                {locked ? "🔒" : node.emoji}
              </text>
              <text
                x={x}
                y={y + 70}
                textAnchor="middle"
                fontSize={17}
                fontWeight={700}
                fill="#2f2a24"
              >
                {node.name}
              </text>
              <text x={x} y={y + 92} textAnchor="middle" fontSize={15} fill="#8c8272">
                {locked ? "还没解锁" : node.level_label}
              </text>
              {node.mastered ? (
                <text x={x + 34} y={y - 30} textAnchor="middle" fontSize={20}>
                  🌟
                </text>
              ) : null}
            </motion.g>
          );
        })}
      </svg>
    </div>
  );
}

/** 成长树旁边的说明：告诉孩子「树是怎么长大的」 */
export function GrowthTreeLegend() {
  return (
    <p className="mt-3 text-base text-world-soft">
      每多做对一点，树上的叶子就会亮一点。亮起来的节点是已经学会的本领。
    </p>
  );
}

export function GrowthTreeFooter() {
  return (
    <p className="mt-2 text-center text-base text-world-soft">
      <Link href="/" className="underline">
        回数学世界
      </Link>
    </p>
  );
}
