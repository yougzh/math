"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getDebugLearningState } from "@/lib/api/endpoints";
import { describeError } from "@/lib/api/errors";
import { useApiResource } from "@/lib/hooks/useApiResource";
import { useAppStore } from "@/lib/store/useAppStore";
import { usePendingAttempts, retryPendingAttempts } from "@/lib/offline/usePendingAttempts";
import { IDLE_SUSPECT_MIN_MS, THINKING_NORMAL_MAX_MS } from "@/lib/telemetry/constants";
import type { DebugSignalRow } from "@/lib/api/types";

/**
 * 调试面板：只在 `?debug=1` 时出现，正常孩子看不到。
 *
 * 展示三类原始信息（不做任何美化解释）：
 * 1. 最近一次作答的三项时间 —— 用来现场验证 ADR-0003 是否被正确实现
 * 2. GET /v1/debug/learning-state 的原始信号
 * 3. 断网暂存队列
 */
export function DebugPanel() {
  const params = useSearchParams();
  const fromQuery = params?.get("debug") === "1";
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);

  /**
   * `?debug=1` 只对当前 URL 生效，一旦点进故事就会丢。
   * 调试时最需要的恰恰是「一边玩一边看埋点」，所以这里把它记在本标签页的
   * sessionStorage 里持续生效；点「关掉调试」才清除。
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (fromQuery) {
      window.sessionStorage.setItem(DEBUG_FLAG_KEY, "1");
      setEnabled(true);
      return;
    }
    setEnabled(window.sessionStorage.getItem(DEBUG_FLAG_KEY) === "1");
  }, [fromQuery]);

  const disable = () => {
    if (typeof window !== "undefined") window.sessionStorage.removeItem(DEBUG_FLAG_KEY);
    setEnabled(false);
    setOpen(false);
  };

  if (!enabled) return null;

  return (
    <div className="fixed bottom-3 left-3 z-50 text-left">
      {open ? (
        <div className="max-h-[80vh] w-[min(92vw,460px)] overflow-y-auto rounded-2xl border border-slate-300 bg-white/97 p-3 shadow-xl backdrop-blur">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-sm font-bold text-slate-700">
              🐞 调试面板 (真实后端)
            </span>
            <button
              type="button"
              onClick={disable}
              className="ml-auto rounded-md border border-slate-300 px-2 py-1 text-xs"
            >
              关掉调试
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md border border-slate-300 px-2 py-1 text-xs"
            >
              收起
            </button>
          </div>
          <div className="space-y-3 text-xs leading-relaxed text-slate-700">
            <TelemetrySection />
            <PendingSection />
            <LearningStateSection />
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex h-11 w-11 items-center justify-center rounded-full border border-slate-300 bg-white/95 shadow-lg"
          aria-label="打开调试面板"
        >
          🐞
        </button>
      )}
    </div>
  );
}

const DEBUG_FLAG_KEY = "math_world.debug";

function TelemetrySection() {
  const telemetry = useAppStore((s) => s.lastTelemetry);
  return (
    <section className="rounded-lg bg-slate-50 p-2">
      <h3 className="font-bold text-slate-800">本次作答时间（ADR-0003）</h3>
      {telemetry ? (
        <ul className="mt-1 space-y-0.5 font-mono">
          <li>response_time_ms = {telemetry.response_time_ms}</li>
          <li>active_time_ms = {telemetry.active_time_ms}</li>
          <li>idle_time_ms = {telemetry.idle_time_ms}</li>
          <li className="text-slate-500">
            thinking_time_ms ≈ {Math.max(0, telemetry.response_time_ms - telemetry.active_time_ms - telemetry.idle_time_ms)}{" "}
            （**不上报**，服务端算）
          </li>
          <li className="text-slate-500">idle_segments = {JSON.stringify(telemetry.idle_segments)}</li>
          <li className="text-slate-500">interaction_count = {telemetry.interaction_count}</li>
        </ul>
      ) : (
        <p className="mt-1 text-slate-500">还没有作答记录。</p>
      )}
      <p className="mt-1 text-[11px] text-slate-500">
        阈值：&lt;{THINKING_NORMAL_MAX_MS / 1000}s 正常思考 / &gt;
        {IDLE_SUSPECT_MIN_MS / 1000}s 才算疑似离开。**没有任何「超时即无效」的逻辑**。
      </p>
    </section>
  );
}

function PendingSection() {
  const pending = usePendingAttempts();
  return (
    <section className="rounded-lg bg-slate-50 p-2">
      <h3 className="font-bold text-slate-800">
        待补交作答：{pending.length} 条
        <button
          type="button"
          onClick={() => void retryPendingAttempts()}
          className="ml-2 rounded border border-slate-300 px-1.5 py-0.5 text-[11px]"
        >
          立即重放
        </button>
      </h3>
      {pending.length > 0 ? (
        <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
          {pending.map((p) => (
            <li key={p.client_attempt_id}>
              {p.body.item_code} · tries={p.tries} · {p.last_error ?? "-"}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-slate-500">没有积压，说明提交都成功了。</p>
      )}
    </section>
  );
}

function LearningStateSection() {
  const childId = useAppStore((s) => s.childId);
  const { data, error, loading, reload } = useApiResource(
    () => getDebugLearningState(childId),
    [childId],
  );
  const [raw, setRaw] = useState(false);

  return (
    <section className="rounded-lg bg-slate-50 p-2">
      <h3 className="flex items-center gap-2 font-bold text-slate-800">
        学习状态（原始信号）
        <button
          type="button"
          onClick={() => setRaw((v) => !v)}
          className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px]"
        >
          {raw ? "结构化" : "原始 JSON"}
        </button>
        <button
          type="button"
          onClick={reload}
          className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px]"
        >
          刷新
        </button>
      </h3>

      {loading ? <p className="mt-1 text-slate-500">读取中…</p> : null}
      {error ? <p className="mt-1 text-red-600">{error}</p> : null}

      {data && !raw ? <StructuredState data={data} /> : null}
      {data && raw ? (
        <pre className="mt-1 max-h-64 overflow-auto rounded bg-white p-2 text-[10px]">
          {JSON.stringify(data, null, 2)}
        </pre>
      ) : null}
    </section>
  );
}

function StructuredState({ data }: { data: unknown }) {
  const obj = data as {
    algorithm_version?: number | string;
    updated_at?: string;
    competencies?: DebugSignalRow[];
    patterns?: DebugSignalRow[];
  };
  const competencies = Array.isArray(obj.competencies) ? obj.competencies : [];
  const patterns = Array.isArray(obj.patterns) ? obj.patterns : [];

  if (competencies.length === 0 && patterns.length === 0) {
    return (
      <pre className="mt-1 max-h-64 overflow-auto rounded bg-white p-2 text-[10px]">
        {JSON.stringify(data, null, 2)}
      </pre>
    );
  }

  const row = (r: DebugSignalRow, key: string) => (
    <li key={key} className="mt-1 rounded bg-white p-1.5">
      <div className="flex flex-wrap items-center gap-1">
        <b>{r.code ?? r.competency}</b>
        {r.pattern ? <span className="text-slate-500">· {String(r.pattern)}</span> : null}
        <span>{r.level_label ?? r.level}</span>
        <span className="text-slate-500">n={r.sample_count ?? "-"}</span>
        {r.scaffold_level ? <span className="text-slate-500">scaffold={r.scaffold_level}</span> : null}
      </div>
      <div className="mt-0.5 flex flex-wrap gap-2 font-mono text-[10px] text-slate-600">
        {Object.entries(r.signals ?? {}).map(([k, v]) => (
          <span key={k}>
            {k}={v === null || v === undefined ? "null" : Number(v).toFixed(2)}
          </span>
        ))}
      </div>
      {r.method_distribution ? (
        <div className="mt-0.5 font-mono text-[10px] text-slate-500">
          methods={JSON.stringify(r.method_distribution)}
        </div>
      ) : null}
    </li>
  );

  return (
    <div className="mt-1">
      <p className="text-[11px] text-slate-500">
        algorithm_version = {String(obj.algorithm_version ?? "-")} · updated_at ={" "}
        {obj.updated_at ?? "-"}
      </p>
      <ul>
        {competencies.map((r, i) => row(r, `c${i}`))}
        {patterns.map((r, i) => row(r, `p${i}`))}
      </ul>
    </div>
  );
}
