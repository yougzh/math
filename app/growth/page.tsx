"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { getGrowth, postBuild } from "@/lib/api/endpoints";
import { describeError } from "@/lib/api/errors";
import { useApiResource } from "@/lib/hooks/useApiResource";
import { useAppStore } from "@/lib/store/useAppStore";
import { MATERIAL_META, MaterialBar } from "@/components/ui/MaterialBar";
import { ErrorState } from "@/components/ui/StateViews";
import { Loading, InlineLoading } from "@/components/ui/Loading";
import { PageShell } from "@/components/ui/PageShell";
import { GrowthTree, GrowthTreeLegend } from "@/components/growth/GrowthTree";
import type { Building, Materials } from "@/lib/api/types";

/**
 * 我的成长。
 *
 * 材料、建筑、徽章都来自服务端（契约 §9）；建造走 POST /v1/growth/build，
 * 材料够不够**以服务端判定为准**，前端算的只是给孩子看的提示文案。
 */
export default function GrowthPage() {
  const childId = useAppStore((s) => s.childId);
  const { data, error, loading, reload } = useApiResource(() => getGrowth(childId), [childId]);

  const [materials, setMaterials] = useState<Materials | null>(null);
  const [buildings, setBuildings] = useState<Building[] | null>(null);
  const [busyCode, setBusyCode] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setMaterials(data.materials);
    setBuildings(data.buildings);
  }, [data]);

  const build = useCallback(
    async (building: Building) => {
      setBusyCode(building.code);
      setNote(null);
      try {
        const res = await postBuild({ child_id: childId, building_code: building.code });
        setMaterials(res.materials);
        if (res.built) {
          setBuildings((prev) =>
            (prev ?? []).map((b) => (b.code === building.code ? { ...b, built: true } : b)),
          );
          setNote(
            `🔨 ${building.name} 建好啦！` +
              (res.unlocks.length > 0 ? ` 新的地方解锁了：${res.unlocks.join("、")}` : ""),
          );
        } else {
          setNote(`🧱 ${res.reason ?? "材料还不够，再攒一攒。"}`);
        }
      } catch (e) {
        setNote(describeError(e));
      } finally {
        setBusyCode(null);
      }
    },
    [childId],
  );

  if (loading) return <Loading label="正在看你的成长树…" />;
  if (error) {
    return (
      <div className="p-5">
        <ErrorState message={error} onRetry={reload} />
      </div>
    );
  }
  if (!data) return null;

  const currentMaterials = materials ?? data.materials;

  return (
    <PageShell title="我的成长" emoji="🌱">
      <div className="flex flex-col gap-6">
        <section className="kid-card">
          <h2 className="mb-2 text-kid-xl font-extrabold">🌳 我的成长树</h2>
          <GrowthTree tree={data.tree} />
          <GrowthTreeLegend />
        </section>

        <section className="kid-card">
          <h2 className="mb-3 text-kid-xl font-extrabold">🧺 我的材料</h2>
          <MaterialBar materials={currentMaterials} />
          <p className="mt-2 text-base text-world-soft">
            材料是做对题的时候攒下来的，和数学表现有关，不是随便发的。
          </p>
        </section>

        <section className="kid-card">
          <h2 className="mb-3 text-kid-xl font-extrabold">🏗️ 可以造的东西</h2>
          <ul className="space-y-3">
            {(buildings ?? []).map((building) => (
              <BuildingRow
                key={building.code}
                building={building}
                materials={currentMaterials}
                busy={busyCode === building.code}
                onBuild={() => void build(building)}
              />
            ))}
          </ul>
          {note ? (
            <motion.p
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-3 rounded-kid bg-[#fff8e3] px-4 py-3 text-kid"
              role="status"
            >
              {note}
            </motion.p>
          ) : null}
        </section>

        <section className="kid-card">
          <h2 className="mb-3 text-kid-xl font-extrabold">🎖️ 我的徽章</h2>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {data.badges.map((badge) => (
              <li
                key={badge.code}
                className={`flex flex-col items-center gap-1 rounded-2xl p-3 text-center ${
                  badge.earned ? "bg-[#fff8e3] shadow-kid-sm" : "bg-[#f2ece1] opacity-70"
                }`}
              >
                <span className={`text-4xl ${badge.earned ? "" : "grayscale"}`} aria-hidden>
                  {badge.earned ? badge.emoji : "❔"}
                </span>
                <span className="text-base font-bold">{badge.name}</span>
                <span className="text-sm text-world-soft">
                  {badge.earned ? "已得到" : "还没得到"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </PageShell>
  );
}

function BuildingRow({
  building,
  materials,
  busy,
  onBuild,
}: {
  building: Building;
  materials: Materials;
  busy: boolean;
  onBuild: () => void;
}) {
  const missing = Object.entries(building.cost)
    .map(([code, need]) => {
      const have = (materials as unknown as Record<string, number>)[code] ?? 0;
      return { code, need, have, lack: Math.max(0, need - have) };
    })
    .filter((x) => x.lack > 0);

  const affordable = missing.length === 0;

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-2xl bg-[#f8f3e9] p-3">
      <span className="text-4xl" aria-hidden>
        {building.emoji}
      </span>
      <div className="min-w-[160px] flex-1">
        <p className="text-kid-lg font-extrabold">{building.name}</p>
        <p className="flex flex-wrap items-center gap-2 text-base text-world-soft">
          {Object.entries(building.cost).map(([code, need]) => {
            const meta = MATERIAL_META[code] ?? { emoji: "❔", name: code };
            const lack = missing.find((m) => m.code === code)?.lack ?? 0;
            return (
              <span
                key={code}
                className={`rounded-pill px-2 py-0.5 ${lack > 0 ? "bg-[#ffe6e0] text-[#8a3d2a]" : "bg-white"}`}
              >
                {meta.emoji} {meta.name} {need}
                {lack > 0 ? `（还差 ${lack}）` : ""}
              </span>
            );
          })}
        </p>
      </div>

      {building.built ? (
        <span className="rounded-pill bg-[#eaf9e6] px-4 py-2 text-base font-bold text-[#1f5c14]">
          ✅ 已经建好
        </span>
      ) : (
        <button
          type="button"
          disabled={!affordable || busy}
          onClick={onBuild}
          className="kid-btn min-h-[52px] bg-world-grass px-5 text-kid text-[#123d0a] shadow-kid disabled:bg-[#e7e0d3] disabled:text-world-soft disabled:shadow-none"
        >
          {busy ? <InlineLoading label="建造中…" /> : affordable ? "建造" : "材料不够"}
        </button>
      )}
    </li>
  );
}
