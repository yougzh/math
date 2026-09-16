/**
 * 生成 client_attempt_id（幂等键的一半，见契约 §0）。
 *
 * 断网重放时**必须复用**同一个 id，否则会被服务端当成两次不同的作答。
 * 因此 id 在「入队」那一刻生成并随请求体一起持久化，重放时不再重新生成。
 */
export function newClientAttemptId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();

  // 退化路径：非安全上下文（http 且非 localhost）没有 randomUUID
  const rand = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  const ts = Date.now().toString(16).padStart(12, "0").slice(-12);
  return `${ts.slice(0, 8)}-${ts.slice(8, 12)}-4${rand().slice(0, 3)}-a${rand().slice(0, 3)}-${rand()}${rand()}${rand()}`;
}
