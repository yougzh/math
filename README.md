# 数学世界（math-world）

面向 8～9 岁（小学二三年级）、数学基础偏弱孩子的**轻游戏化数学自适应学习系统**。

> 孩子以为自己在玩故事，实际上一直在进行数学训练。

```
孩子看到：  游戏世界
家长看到：  数学成长
系统看到：  能力状态
```

---

## 当前状态

Python 全栈（FastAPI + SQLAlchemy）已于迁移 S6 整体删除，现在是 **Next.js 全栈
（TypeScript）**：前端（Next 16 App Router）+ API（`/api/v1/*` Route Handler）+
引擎 + 数据层全部在同仓同进程。迁移通过对拍完成 —— 18 个对拍 fixture
（`tests/oracle/fixtures/` + `tests/fixtures/api_parity.json`）是删除 Python 后
唯一的回归基准，逐模块与 Python 行为逐字段一致后才切换。

| 能力 | 内容 |
|---|---|
| 内容 | 1373 题 / 10 能力 / 52 槽 / 10 故事（`content/` YAML，构建期编译） |
| 引擎 | 熟练度 EWMA + 等级派生 + 间隔复习调度（1/3/7/14/30 天）+ 侦探谜题（确定性 PRNG） |
| API | 14 个契约端点（`docs/api-contract.md`）+ 并发三层防护（advisory lock + 原子 seq + 23505 重试） |
| 前端 | 7 页儿童端（"use client"）+ 家长报告 + 调试面板 |
| 测试 | vitest 1113 个（对拍 + 契约 + 单元）+ Playwright e2e smoke |

---

## 快速开始

```bash
npm install
npm run db:init    # 启动本地嵌入式 PostgreSQL（免 root 免 Docker，数据在 ~/.math-pg）
npm run db:import  # 内容 dump → 导入 PG（可重复执行，不产生重复行）
npm run dev        # http://localhost:3000（predev 会先生成内容产物）
```

环境变量：`.env` 的 `MATH_DB_URL` 指向数据库（本机默认
`postgresql://postgres@127.0.0.1:5432/db_math`）。前端与 API 同源，无需单独起后端。

常用命令：

```bash
npm test              # vitest 全量回归（对拍 fixture 驱动）
npm run typecheck     # tsc --noEmit
npm run build         # 内容构建 + next build
npm run start         # 本地生产部署（需先 build；同源 API + 本地 PG）
npx tsx scripts/simulate.ts   # 7 画像 × 30 天模拟体检
npm run test:e2e      # Playwright e2e smoke（需先 build + start）
```

内容工作台（validate / lint / stats / dump）：

```bash
npm run check:content   # validate + lint
npm run stats:content   # 覆盖度报表
npm run build:content   # content/ + config/ → src/generated/
```

`src/generated/` 是 gitignore 的。产物里记着 `source_fingerprint`（输入文件的
SHA-256），对拍测试会拿它和当前 `content/`、`config/` 比对 —— **改了内容不重新
构建会直接报错**，而不是静默地拿旧产物继续跑。

环境要求：Node 20.9+（实测用 26）、本地 PostgreSQL（嵌入式脚本已内置）。

---

## 学习决策链（系统的大脑）

```
Child State
     ↓
Learning Intent        # 今天要达成什么（不是"做哪道题"）
     ↓
Daily Plan             # 时间预算切分
     ↓
Story                  # 为什么做
     ↓
Challenge Slot         # 练什么（pattern + 难度区间 + 策略）
     ↓
Item Selection         # 具体做哪一道
     ↓
Child Interaction
     ↓
Attempt                # 学习系统唯一事实入口
     ↓
Diagnosis
     ↓
Proficiency Update
     ↓
Next Learning Intent
```

三层职责不允许越界：

| 层 | 回答的问题 | 不允许做的事 |
|---|---|---|
| Story | 为什么做 | 不允许指定具体题目 |
| Challenge Slot | 练什么 | 不允许指定具体题目 |
| Planner / Item Selector | 具体做哪一道 | 不允许改变故事与 slot 的语义 |

---

## 目录

```
app/                        # Next.js App Router：7 个页面 + /api/v1/* Route Handler
components/ lib/            # 儿童端组件与客户端取数（useApiResource / zustand / 断网重放）
src/
  content/                  # 内容模型 + 构建期 loader/编译/校验
  generated/                # ★ 构建产物（gitignore）：content/content.index/config.json
  engine/                   # 学习引擎（proficiency/state_machine/scheduler/planner/...）
  coach/                    # AI 教练 + 四道护栏 + LLM 适配器（可离线）
  lab/                      # 实验室解锁
  service/                  # 事务化提交（17 步）/ 成长 / 家长报告 / 内容装载
  api/                      # 路由层：schema 校验 + 错误形状 + 依赖注入
  db/                       # Drizzle ORM（24 张表）+ 连接
  py/                       # Python 语义兼容层（int/float/round/re/sort/random）
content/ config/            # YAML 内容与配置（唯一人工维护源）
db/migrations/0001_init.sql # PostgreSQL schema
scripts/                    # build-content / init-db / db-local / simulate / mutation-check
tests/
  oracle/fixtures/          # ★ 对拍黄金语料（提交进仓库 —— Python 删除后的唯一基准）
  fixtures/                 # api_parity.json（28 场景契约对拍）
  unit/ contract/ acceptance/ e2e/ load/
docs/
  api-contract.md           # 前后端契约（端点的唯一事实来源）
  开发计划-V1.2.md
  adr/                      # 不可随意修改的架构决策
```

---

## 不可随意修改的决策（ADR）

改动前必读 `docs/adr/`：

| 编号 | 决策 |
|---|---|
| ADR-0001 | 故事通过 **Challenge Slot** 与题目解耦 —— 故事固定，数学训练动态 |
| ADR-0002 | 熟练度等级是**派生值**，不落库为权威；状态只存信号 + `algorithm_version` |
| ADR-0003 | **思考时间不是无效时间** —— thinking 与 idle 分开计算，禁止一刀切剔除 |
| ADR-0004 | **Attempt 是学习系统唯一事实入口** —— 前端不得直接修改学习状态 |
| ADR-0005 | **侦探答题不是学习事实** —— 不进 attempt / 熟练度 / 复习调度 |
| ADR-0006 | **Python → TypeScript 全量迁移** —— 18 个对拍 fixture 是行为基准；三项已知行为变更 |

---

## 几个容易踩的点

**等级 ≠ 升级。** 等级（🌱🌿🌳⭐🔥）描述"现在处于什么状态"，是派生值；升级是一个严格门，
必须集齐 accuracy / mastery / independence / transfer / fluency + 样本数 + 前置能力 + 迁移证据。
孩子等级到了 ⭐ 也可能因为前置能力未达标而继续留在当前能力上 —— 这是有意的。

**没测过 ≠ 不达标。** 未采样过的信号在等级派生时直接跳过，不会因为"没测过"卡住等级；
但在升级门里必须明确"尚无证据"。

**pattern 状态的键含 competency。** `decompose` 用在 make_ten 和用在 td_add_nocarry 上
不是同一个技能；而"迁移"的定义恰恰是"同一能力、不同 pattern"。

**probe 不产生升级。** 冷启动探测题权重打折，且不计入升级所需的正式练习样本。

**对拍 fixture 不可再生成。** 生成器（Python）已随迁移删除，fixture 是冻结的历史行为
基准 —— 改引擎语义前先想清楚它是不是有意的行为变更（进 ADR），别顺手"修"到 fixture 全红。

---

## 下一步（需要产品判断，不是工程 bug）

1. **迁移探针的阈值语义**：升级要求 `transfer ≥ 0.8`，但探针考的是**从没练过的
   pattern**（`prefer_untried_pattern`）。模拟里「快但脆型」30 天 transfer=0.0
   ——探针全错，升级被卡死。三个方向：探针先给一次示范再考 / transfer 改按
   新结构下的一般正确率计 / 降阈值 + 多次采样取均值。
2. **内容 d4 债**（`check:content` 的 10 条警告，非阻塞）：`make_ten` 与
   `sd_add_10` 的槽声明上限 d4 但内容最高 d3；`st09` 三个故事槽绑 `increase`
   而 blocks/direct 层没有该 pattern 的题。
3. **家长报告要配"最近趋势"**：等级是 EWMA 派生值，只记最近十几次作答。
   模拟里「平台型」显示 ⭐ 熟练而其 30 天均值只有 0.68 —— 只给等级会误导家长。
4. **跨能力难度标尺不连续**：难度是能力内标尺，换能力时会出现 +2 跳变。要做
   全局连续需要重做难度定义。
