import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * vitest 配置。
 *
 * 注意别名要与 tsconfig.json 的 paths 保持一致（TS 编译用 tsconfig，
 * 运行时解析用这里，两边不同步会出现「类型能过、测试跑不起来」）。
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globals: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
      "@engine": path.resolve(import.meta.dirname, "src/engine"),
      "@py": path.resolve(import.meta.dirname, "src/py"),
      // server-only 的 exports 条件是 react-server → empty.js，default → index.js（抛异常）。
      // vitest 不会走 react-server 条件，于是 src/content/bundle.ts 一 import 就炸。
      // 测试跑在 Node 里本来就不存在"client component"，直接指向空模块才是它的本意。
      "server-only": path.resolve(import.meta.dirname, "node_modules/server-only/empty.js"),
    },
  },
});
