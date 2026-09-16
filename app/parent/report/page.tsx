"use client";

import { useState } from "react";
import Link from "next/link";
import { getParentReport } from "@/lib/api/endpoints";
import { useApiResource } from "@/lib/hooks/useApiResource";
import { useAppStore } from "@/lib/store/useAppStore";
import type { CompetencyReportRow, ProgressSignals } from "@/lib/api/types";

/**
 * 家长端 · 数学成长报告。
 *
 * 风格与儿童端刻意相反：克制、信息密度高、没有任何动画与表情轰炸。
 * 只呈现结论与证据，不呈现"知识点清单"。
 */
export default function ParentReportPage() {
  const childId = useAppStore((s) => s.childId);
  const [days, setDays] = useState(7);
  const { data, error, loading, reload } = useApiResource(
    () => getParentReport(childId, days),
    [childId, days],
  );

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-5 py-4">
          <Link href="/" className="text-sm text-slate-500 underline">
            ← 回儿童端
          </Link>
          <h1 className="text-lg font-semibold">数学成长报告</h1>
          {data ? (
            <span className="text-sm text-slate-500">
              {data.child.name} · {data.range.from} ~ {data.range.to}
            </span>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            {[7, 14, 30].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                className={`rounded-md border px-2.5 py-1 text-sm ${
                  days === d ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300"
                }`}
              >
                {d} 天
              </button>
            ))}
            <button
              type="button"
              onClick={reload}
              className="rounded-md border border-slate-300 px-2.5 py-1 text-sm"
            >
              刷新
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-5 px-5 py-6">
        {loading ? <p className="text-sm text-slate-500">读取中…</p> : null}
        {error ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
            {error}
          </div>
        ) : null}

        {data ? (
          <>
            {/* 结论先行 */}
            <section className="rounded-xl border border-slate-200 bg-white p-6">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">本周结论</p>
              <p className="mt-2 text-xl font-semibold leading-relaxed sm:text-2xl">
                {data.headline}
              </p>
            </section>

            <div className="grid gap-5 lg:grid-cols-3">
              <section className="rounded-xl border border-slate-200 bg-white p-5 lg:col-span-2">
                <h2 className="text-sm font-semibold text-slate-500">能力分布</h2>
                <ul className="mt-4 space-y-5">
                  {data.competencies.map((row) => (
                    <CompetencyRow key={row.code} row={row} />
                  ))}
                </ul>
              </section>

              <section className="space-y-5">
                <div className="rounded-xl border border-slate-200 bg-white p-5">
                  <h2 className="text-sm font-semibold text-slate-500">参与度</h2>
                  <dl className="mt-3 space-y-2 text-sm">
                    <Stat label="本周练习" value={`${data.engagement.sessions} 次`} />
                    <Stat label="总时长" value={`${data.engagement.total_minutes} 分钟`} />
                    <Stat
                      label="单次平均"
                      value={`${data.engagement.avg_minutes_per_session} 分钟`}
                    />
                    <Stat
                      label="第二天还来"
                      value={formatPercent(data.engagement.next_day_return_rate)}
                    />
                    <Stat
                      label="故事完成率"
                      value={formatPercent(data.engagement.story_completion_rate)}
                    />
                  </dl>
                </div>

                <div className="rounded-xl border border-slate-200 bg-white p-5">
                  <h2 className="text-sm font-semibold text-slate-500">错误认知</h2>
                  {data.misconceptions.length === 0 ? (
                    <p className="mt-3 text-sm text-slate-500">本周没有发现明显的错误模式。</p>
                  ) : (
                    <ul className="mt-3 space-y-3">
                      {data.misconceptions.map((m) => (
                        <li key={m.code}>
                          <p className="text-sm font-medium">
                            {m.name}
                            <span className="ml-2 text-xs text-slate-500">出现 {m.hit_count} 次</span>
                          </p>
                          <p className="mt-1 text-sm text-slate-600">{m.text}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <section className="rounded-xl border border-slate-200 bg-white p-5">
                <h2 className="text-sm font-semibold text-slate-500">薄弱点与建议对策</h2>
                {data.weak_points.length === 0 ? (
                  <p className="mt-3 text-sm text-slate-500">本周没有需要特别关注的地方。</p>
                ) : (
                  <ul className="mt-3 space-y-4">
                    {data.weak_points.map((w) => (
                      <li key={`${w.type}-${w.competency}`} className="border-l-2 border-slate-200 pl-3">
                        <p className="text-xs uppercase tracking-wide text-slate-400">
                          {WEAK_TYPE_LABEL[w.type] ?? w.type} · {w.competency}
                        </p>
                        <p className="mt-1 text-sm leading-relaxed">{w.text}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="rounded-xl border border-slate-200 bg-white p-5">
                <h2 className="text-sm font-semibold text-slate-500">最近的进步</h2>
                <ol className="mt-3 space-y-3">
                  {data.progress.map((p) => (
                    <li key={`${p.date}-${p.note}`} className="flex gap-3 text-sm">
                      <span className="w-24 shrink-0 whitespace-nowrap tabular-nums text-slate-400">
                        {p.date}
                      </span>
                      <span>
                        <span className="mr-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                          {p.level}
                        </span>
                        {p.note}
                      </span>
                    </li>
                  ))}
                  {data.progress.length === 0 ? (
                    <li className="text-sm text-slate-500">本周还没有可记录的进步节点。</li>
                  ) : null}
                </ol>
              </section>
            </div>

            <section className="rounded-xl border border-slate-200 bg-white p-5">
              <h2 className="text-sm font-semibold text-slate-500">给家长的建议</h2>
              <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed">
                {data.advice.map((advice) => (
                  <li key={advice}>{advice}</li>
                ))}
              </ul>
            </section>

            <p className="pb-8 text-xs leading-relaxed text-slate-500">{data.disclaimer}</p>
          </>
        ) : null}
      </main>
    </div>
  );
}

const SIGNAL_LABEL: Record<keyof ProgressSignals, string> = {
  mastery: "掌握",
  accuracy: "正确率",
  fluency: "流畅度",
  independence: "独立性",
  transfer: "迁移",
};

const WEAK_TYPE_LABEL: Record<string, string> = {
  fluency: "流畅度不足",
  accuracy: "正确率不足",
  transfer: "迁移未达",
  independence: "依赖提示",
  mastery: "掌握不足",
};

function CompetencyRow({ row }: { row: CompetencyReportRow }) {
  return (
    <li>
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium">{row.name}</span>
        <span className="text-xs text-slate-500">{row.level_label}</span>
        <span className="ml-auto tabular-nums text-sm text-slate-500">
          {row.score.toFixed(2)}
        </span>
      </div>

      {/* 主条形：score */}
      <div className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full bg-slate-700"
          style={{ width: `${Math.round(row.score * 100)}%` }}
        />
      </div>

      {/* 五个信号的细条（null 表示尚无样本，显示为「暂无数据」而不是 0） */}
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-5">
        {(Object.keys(SIGNAL_LABEL) as Array<keyof ProgressSignals>).map((key) => {
          const value = row.signals?.[key] ?? null;
          return (
            <div key={key}>
              <dt className="text-[11px] text-slate-400">{SIGNAL_LABEL[key]}</dt>
              <dd className="mt-0.5 flex items-center gap-1.5">
                <span className="h-1.5 w-full max-w-[70px] overflow-hidden rounded-full bg-slate-100">
                  {value !== null ? (
                    <span
                      className="block h-full rounded-full bg-slate-400"
                      style={{ width: `${Math.round(value * 100)}%` }}
                    />
                  ) : null}
                </span>
                <span className="tabular-nums text-[11px] text-slate-500">
                  {value === null ? "尚无样本" : value.toFixed(2)}
                </span>
              </dd>
            </div>
          );
        })}
      </dl>
    </li>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function formatPercent(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return `${Math.round(v * 100)}%`;
}
