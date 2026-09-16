# ADR-0006：Python → TypeScript 全量迁移

- 状态：已接受
- 日期：2026-09-16
- 取代：无

## 背景

原型期技术栈是 Python（FastAPI + SQLAlchemy + pytest），前端 Next.js 通过
`NEXT_PUBLIC_API_BASE` 打独立后端进程。这个形态带来三类成本：

1. **部署**：两套运行时两套部署（Vercel + 任意 Python 宿主），而目标部署是
   Vercel 一键；serverless 平台上 Python 冷启动与常驻成本都更高。
2. **契约漂移**：前后端两仓（两语言）各自理解同一份契约，靠人肉对齐；
   pydantic 与手写 TS 类型之间没有机械一致性保证。
3. **双份领域逻辑**：内容校验/编译在 Python（构建期），而运行时引擎在
   Python —— 但前端类型定义又抄了一遍，三处漂移点。

## 决策

**路线 A：全量移植。** Python 的引擎、服务、数据层全部用 TypeScript 重写，
Next.js 变全栈（App Router + Route Handler 同进程），Python 代码在验收通过后
**整体删除**（本 ADR 生效时已完成，仓库中不再有 .py 文件）。

关键子决策：

1. **数据库零改动**：24 表 DDL（`db/migrations/0001_init.sql`）一字不改沿用，
   生产用 Neon Postgres（NUMERIC/JSONB/交互式事务全部保住 —— 这是放弃
   Cloudflare D1/Durable Objects 的原因）。
2. **Python 语义兼容层**（`src/py/`）：int 边界、half-even round、正则、
   排序 tie-break、MT19937 等 Python 运行时语义显式复刻，不写成"地道 TS"。
3. **对拍 fixture 是唯一行为基准**：18 个 fixture（`tests/oracle/fixtures/` +
   `tests/fixtures/api_parity.json`）由 Python dump，覆盖内容/引擎/侦探/规划/
   契约 28 场景。每一类都配了突变测试证明断言有约束力（S1~S4 累计 200+ 次突变
   探测）。**fixture 生成器随 Python 一起删除** —— fixture 从此冻结，改引擎
   语义 = 有意的行为变更，必须先进 ADR 再改代码。
4. **并发三层防护**（serverless 无进程内锁）：`pg_advisory_xact_lock(child_id)`
   + `INSERT` 内嵌 `COALESCE(MAX(seq))+1` 原子表达式 + 23505 重试（20/50/120ms，
   重开事务先查幂等键）。20 并发压测验证：seq 1..20 无重复；同幂等键恰好
   1 个 created + 19 个响应逐字相同。
5. **全量重放不做增量**：每次 attempt 事务内重放该孩子全部历史（579 条实测
   13.5ms），换实现简单与状态绝对一致，不加快照表。
6. **Next 16.3.5 + React 19**：原计划保留 Next 14，被 `npm audit` 推翻
   （14.x 已无安全版本，request smuggling in rewrites 正打在迁移路径上）。

## 已知行为变更（3 项，迁移验收时逐项签字确认）

这 3 项之外的行为差异一律视为移植缺陷：

1. **UTC 日历日口径**：Python 版家长报告用容器本地时区的 `date.today()` 与
   naive UTC 的 `created_at` 混算（且存在 naive/naive 相减在 aware 读回时
   TypeError 的真 bug）。TS 版统一 UTC 自然日。影响：报告"到昨天的天数 /
   连续性"在 CST 部署机上与旧版可能差一天。
2. **4 位量化舍入**：`NUMERIC(5,4)` 存储一致，但写入前的量化统一按 Python
   `round` 的 half-even（`pyRound`），不用 PG 的 half-away-from-zero。
3. **侦探在途谜题**：仅当确定性 PRNG 退路（sha256 派生）被启用时存在；
   当前 MT19937 逐位兼容对拍通过（2000 种子 × 3 kind），该窗口为空。

## 后果

**正面**

- 单仓单语言单进程：`npm run build` 一次拿到前端 + API；Vercel 一键部署
- 契约靠 28 场景逐字段对拍锁定，pydantic 手写等价校验（字段顺序/lax 语义）
  有专门测试
- 引擎可在浏览器外复用（模拟器 `scripts/simulate.ts` 直接跑产品级引擎）

**代价 / 风险**

- **fixture 冻结**：内容或算法演进到 fixture 覆盖不到的形态时，没有 oracle
  可重新 dump —— 只能靠单测 + 恒等式自证。演进时优先扩 fixture（手写期望值）
  再改代码
- `src/py/` 兼容层是永久税：新代码也要知道"这里必须用 pyRound 而不是
  Math.round"
- serverless 事务语义依赖 Node runtime + pg 驱动（禁 Edge runtime、禁
  neon-http 驱动进事务），误用会本地通过、线上静默失败 —— 已在
  `src/db/client.ts` 与 route 声明中固化

## 违反时的表现（自检）

- 仓库出现 .py 运行时依赖（package.json scripts / Makefile 调 python3）→ 违反
- 绕过 fixture 直接改引擎数值（EWMA/阈值/tie-break）且未进 ADR → 违反
- Route Handler 缺 `runtime = "nodejs"` 或用 http 驱动开事务 → 违反
- 幂等键不再走 `(child_id, client_attempt_id)` 唯一约束 → 违反
