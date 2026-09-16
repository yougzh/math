"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { getWorld } from "@/lib/api/endpoints";
import { useApiResource } from "@/lib/hooks/useApiResource";
import { useAppStore } from "@/lib/store/useAppStore";
import { MaterialBar } from "@/components/ui/MaterialBar";
import { ErrorState } from "@/components/ui/StateViews";
import { Loading } from "@/components/ui/Loading";
import { TodayCard } from "@/components/world/TodayCard";
import { UniverseCard } from "@/components/world/UniverseCard";

/**
 * 数学世界首页（儿童端）。
 *
 * 刻意**不展示** mastery / 等级数值 / 正确率 —— 孩子看到的是「去哪里玩」，
 * 不是「你练得怎么样」（ADR-0002 的等级是内部派生值，给孩子看只会变成压力）。
 */
export default function WorldHomePage() {
  const childId = useAppStore((s) => s.childId);
  const { data, error, loading, reload } = useApiResource(() => getWorld(childId), [childId]);

  if (loading) return <Loading label="正在打开数学世界…" />;
  if (error) return <div className="p-5"><ErrorState message={error} onRetry={reload} /></div>;
  if (!data) return null;

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <p className="text-kid text-world-soft">{data.child.name}，欢迎回来</p>
          <h1 className="text-kid-2xl font-extrabold">👋 今天去哪里？</h1>
        </div>
        <MaterialBar materials={data.growth_summary.materials} compact />
      </header>

      {data.today ? <TodayCard today={data.today} /> : null}

      <section className="mt-6">
        <h2 className="mb-3 text-kid-xl font-extrabold">🗺️ 去哪里玩</h2>
        <ul className="space-y-3">
          {data.universes.map((universe) => (
            <UniverseCard key={universe.code} universe={universe} />
          ))}
        </ul>
      </section>

      <section className="mt-6 grid gap-3 sm:grid-cols-2">
        <motion.div whileHover={{ y: -2 }}>
          <Link
            href="/lab"
            className="flex min-h-[84px] items-center gap-3 rounded-kid bg-white p-4 shadow-kid-sm"
            aria-disabled={!data.lab_unlocked}
          >
            <span className="text-4xl" aria-hidden>
              🧪
            </span>
            <span className="min-w-0">
              <span className="block text-kid-lg font-extrabold">数学实验室</span>
              <span className="block text-base text-world-soft">
                {data.lab_unlocked ? "随便玩，想摆多少摆多少" : "🔒 还没开放"}
              </span>
            </span>
          </Link>
        </motion.div>

        <motion.div whileHover={{ y: -2 }}>
          <Link
            href="/growth"
            className="flex min-h-[84px] items-center gap-3 rounded-kid bg-white p-4 shadow-kid-sm"
          >
            <span className="text-4xl" aria-hidden>
              🌱
            </span>
            <span className="min-w-0">
              <span className="block text-kid-lg font-extrabold">我的成长</span>
              <span className="block text-base text-world-soft">
                成长树、材料、可以造的房子
              </span>
            </span>
          </Link>
        </motion.div>
      </section>

      <footer className="mt-8 flex flex-col items-center gap-3 pb-6 text-center">
        <p className="text-base text-world-soft">
          今天玩 10～15 分钟就够啦，剩下的明天继续。
        </p>
        <Link href="/parent/report" className="text-base text-world-soft underline">
          家长看这里 →
        </Link>
      </footer>

      {/* 新的徽章用一句轻描淡写的话带过，不做弹窗打断 */}
      {data.growth_summary.newest_badge ? (
        <p className="mt-2 text-center text-base text-world-soft">
          最近拿到：{data.growth_summary.newest_badge.emoji}{" "}
          {data.growth_summary.newest_badge.name}
        </p>
      ) : null}
    </div>
  );
}
