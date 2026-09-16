import { defineConfig } from "@playwright/test";

/**
 * Playwright e2e 配置。
 *
 * 前提：本地嵌入式 PG 已启动且导入过内容（npm run db:start + db:import）。
 * webServer 起 next dev；本机已在跑时复用（reuseExistingServer）。
 *
 * e2e 只走真实链路：真实 Next server + 真实 Postgres + 同源 /api/v1/*，
 * 不 mock 任何东西 —— 它是迁移完成判据 #5（e2e-smoke）的载体。
 */
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  // 单库单孩子，全部串行
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    actionTimeout: 15_000,
    // next dev 按需编译路由，首次访问慢，放宽导航超时
    navigationTimeout: 90_000,
  },
  webServer: {
    // 用生产构建而不是 next dev：dev 模式下 HMR websocket 在 headless
    // Chromium 上握手失败（ERR_INVALID_HTTP_RESPONSE）反复重连，hydration
    // 无法完成，页面永远停在 Loading；生产构建无此问题，且更贴近判据
    // 「真实 Next server」的本意。
    command: "npm run build && npm run start",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: true,
    timeout: 600_000,
  },
});
