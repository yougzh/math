/**
 * 断网暂存与重放（P2 DoD：提交失败时本地缓存 attempt，恢复后重放，不丢数据）。
 *
 * 关键点：
 * - **幂等键在入队时生成并持久化**。重放时复用同一个 `client_attempt_id`，
 *   服务端 (child_id, client_attempt_id) 去重，因此「重放」永远不会变成第二次记录。
 * - 只有「可重试」失败（网络错误 / 5xx / 429）才入队；4xx 是请求本身的问题，
 *   重放多少次都一样，直接丢弃并记录错误。
 * - 页面刷新后队列仍在（localStorage），刷新不会丢 attempt，也不会产生重复 attempt。
 */

import { postAttempt } from "@/lib/api/endpoints";
import { ApiError, isApiError } from "@/lib/api/errors";
import { PENDING_ATTEMPTS_STORAGE_KEY } from "@/lib/telemetry/constants";
import type { AttemptRequest, AttemptResponse } from "@/lib/api/types";

export interface PendingAttempt {
  client_attempt_id: string;
  body: AttemptRequest;
  created_at: number;
  tries: number;
  last_error?: string;
}

export type SubmitOutcome =
  | { status: "sent"; response: AttemptResponse }
  | { status: "queued"; error: ApiError }
  | { status: "rejected"; error: ApiError };

type Listener = (pending: PendingAttempt[]) => void;

const listeners = new Set<Listener>();
let cache: PendingAttempt[] | null = null;
let flushing = false;

function hasStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function read(): PendingAttempt[] {
  if (cache) return cache;
  if (!hasStorage()) return (cache = []);
  try {
    const raw = window.localStorage.getItem(PENDING_ATTEMPTS_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as PendingAttempt[]) : [];
    cache = Array.isArray(parsed) ? parsed : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(items: PendingAttempt[]): void {
  cache = items;
  if (hasStorage()) {
    try {
      window.localStorage.setItem(PENDING_ATTEMPTS_STORAGE_KEY, JSON.stringify(items));
    } catch {
      // 存储写满 / 隐私模式：内存队列仍然可用
    }
  }
  for (const listener of listeners) listener(items);
}

export function getPendingAttempts(): PendingAttempt[] {
  return read();
}

export function subscribePendingAttempts(listener: Listener): () => void {
  listeners.add(listener);
  listener(read());
  return () => {
    listeners.delete(listener);
  };
}

export function enqueueAttempt(body: AttemptRequest, error?: ApiError): void {
  const items = read();
  if (items.some((x) => x.client_attempt_id === body.client_attempt_id)) return;
  write([
    ...items,
    {
      client_attempt_id: body.client_attempt_id,
      body,
      created_at: Date.now(),
      tries: 0,
      last_error: error?.message,
    },
  ]);
}

export function clearPendingAttempts(): void {
  write([]);
}

/**
 * 提交一次作答。
 * - 成功 → 直接把响应交给 UI
 * - 可重试失败 → 入队，UI 走「稍后自动补交」路径，孩子不需要知道
 * - 不可重试失败 → 交给调用方展示
 */
export async function submitAttempt(body: AttemptRequest): Promise<SubmitOutcome> {
  try {
    const response = await postAttempt(body);
    return { status: "sent", response };
  } catch (e) {
    const error = isApiError(e) ? e : ApiError.network(e instanceof Error ? e.message : "提交失败");
    if (error.retryable) {
      enqueueAttempt(body, error);
      return { status: "queued", error };
    }
    return { status: "rejected", error };
  }
}

export interface FlushResult {
  flushed: number;
  dropped: number;
  remaining: number;
}

/** 按入队顺序重放；遇到网络错误立即停止（后端多半还是不可用） */
export async function flushPendingAttempts(): Promise<FlushResult> {
  if (flushing) return { flushed: 0, dropped: 0, remaining: read().length };
  flushing = true;
  let flushed = 0;
  let dropped = 0;

  try {
    let items = read();
    while (items.length > 0) {
      const head = items[0];
      // 不可达：由 items.length > 0 保证。仅为满足 noUncheckedIndexedAccess 收窄。
      if (head === undefined) break;
      try {
        await postAttempt(head.body);
        flushed += 1;
        items = read().filter((x) => x.client_attempt_id !== head.client_attempt_id);
        write(items);
      } catch (e) {
        const error = isApiError(e) ? e : ApiError.network("重放失败");
        if (error.retryable) {
          // 网络仍不可用：保留队列，下次再试（幂等键保证不会重复计数）
          write(
            read().map((x) =>
              x.client_attempt_id === head.client_attempt_id
                ? { ...x, tries: x.tries + 1, last_error: error.message }
                : x,
            ),
          );
          break;
        }
        // 4xx：这条记录请求本身有问题，重放无意义
        dropped += 1;
        write(read().filter((x) => x.client_attempt_id !== head.client_attempt_id));
      }
    }
    return { flushed, dropped, remaining: read().length };
  } finally {
    flushing = false;
  }
}

/** 应用启动时调用一次：监听网络恢复 + 首次重放 */
export function initPendingAttemptFlush(): () => void {
  if (typeof window === "undefined") return () => {};
  const onOnline = () => {
    void flushPendingAttempts();
  };
  window.addEventListener("online", onOnline);
  void flushPendingAttempts();
  return () => window.removeEventListener("online", onOnline);
}
