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

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P0** | 学习模型地基（数据模型 + 熟练度状态机 + Replay + Planner） | ✅ 已完成 |
| **P1** | 内容生产体系（Content Compiler + CLI + JSON Schema） | ✅ 已完成（1373 题 / 10 能力 / 52 槽 / 10 故事） |
| **P2** | 数字车站垂直切片（SQLAlchemy 持久层 + FastAPI 14 端点 + 前端） | ✅ 已完成 |
| **P3** | 自适应引擎（间隔复习调度 + 7 画像 × 30 天模拟体检） | ✅ 已完成 |
| **P4** | AI 教练（四道护栏：不泄答案 / 不超纲 / 长度 / 语气） | ✅ 已完成 |
| **P5～P6** | 成长体系（成长树 / 材料 / 建筑）与家长端报告 | ✅ 已完成 |
| **P7** | 扩展宇宙（侦探谜题 / 实验室） | ✅ 已完成（内容待扩） |

验收基线：`244 passed`，`content_cli validate` 0 错误，前端 `npm run build` 通过。

---

## 快速开始

### 引擎（不依赖数据库与前端）

```bash
make test          # 244 个单元测试
make demo          # P0 端到端演示（attempts → proficiency → replay → planner）
make simulate      # 7 个虚拟孩子 × 30 天模拟体检（固定 seed，可复现）
make engine-check  # test + demo
```

### 内容工作台

```bash
make content-validate   # 结构错误（有错退出码 1）
make content-lint       # 可疑内容（警告，不阻塞）
make content-stats      # 覆盖度报表
make content-dump       # 导出 build/content_dump.json（入库的唯一输入）
make content-check      # validate + lint + stats
make content            # schema + check + dump
```

### 后端 API + 数据库

```bash
make db-init       # 内容 dump → 建库（build/math_world.db），可重复执行
make api           # 起服务 http://127.0.0.1:8000（--reload）
```

### 前端

```bash
npm install
npm run db:init    # 本地嵌入式 PostgreSQL（首次）+ 导入内容
npm run db:start   # 启动本地库（后台常驻）
npm run dev        # http://localhost:3000（predev 会先生成内容产物）
```

S5 起前端与 API 同源：页面数据全部走同源 `/api/v1/*`（Next Route Handler），
不再需要单独起后端服务；`.env` 的 `MATH_DB_URL` 指向本地嵌入式 PG。

### 内容产物（Next 侧，迁移中）

Next 侧不读 YAML，只读构建期产物。`predev` / `prebuild` 会自动生成，
手动重建用：

```bash
npm run build:content   # content/ + config/ → src/generated/{content,content.index,config}.json
npm test                # vitest（49 个）
npm run typecheck
```

`src/generated/` 是 gitignore 的。产物里记着 `source_fingerprint`（输入文件的
SHA-256），对拍测试会拿它和当前 `content/`、`config/` 比对 —— **改了内容不重新
构建会直接报错**，而不是静默地拿旧产物继续跑。

环境要求：Python 3.8+（PyYAML / pytest / FastAPI / uvicorn / SQLAlchemy 2 / pydantic 2 / httpx）、Node 20.9+（Next 16 的最低要求，实测用 26）。

---

## 学习决策链（系统的大脑）

```
Child State
     ↓
Learning Intent        # 今天要达成什么（不是"做哪道题"）
     ↓
Daily Plan             # 时间预算切分
     ↓
Story                  # 为什么做            ← P2
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
backend/
  paths.py
  content/
    loader.py                # YAML → 内容对象 + 结构性校验（含故事/槽位绑定）
    cognitive.py             # 认知有效性校验 + lint
    compiler.py              # validate / lint / stats / preview 的编译入口
    generators.py            # 模板化批量出题（1346 道）
  engine/
    types.py                 # 领域类型（Attempt / Signals / Intent / Decision）
    config.py                # 算法配置加载（阈值禁止硬编码）
    graph.py                 # Competency 能力图谱（拓扑 / 环检测 / 回退目标）
    proficiency.py           # 5 个原始信号 + EWMA（纯函数）
    state_machine.py         # 等级派生 / 升级门 / 回退判定
    diagnosis.py             # 错误认知归因
    learner.py               # 状态推进器（在线与 replay 共用）
    intent.py                # Child State → Learning Intent
    planner.py               # Intent → Daily Plan（含故事段：逐 beat 选题）
    selector.py              # Challenge Slot → Item
    scheduler.py             # 间隔复习调度（1/3/7/14/30 天）
    detective.py             # 侦探谜题生成（保证唯一解 + 非平凡）
    replay.py                # 历史重放
  coach/                     # AI 教练 + 四道护栏 + LLM 适配器（可离线）
  db/                        # SQLAlchemy 模型（24 张表）与 session
  service/                   # 事务化提交 / 状态重建 / 成长 / 家长报告
  api/                       # FastAPI（14 个契约端点）
  lab/                       # 实验室（按派生等级解锁）
content/
  competencies/ patterns/ items/ misconceptions/ slots/ stories/
config/
  algorithm/v0.yaml          # 所有阈值、权重、时间语义
  coach/v0.yaml              # 教练语气与长度护栏
  lab/v0.yaml                # 实验室解锁规则
db/migrations/0001_init.sql  # PostgreSQL schema
src/
  content/                   # 内容模型 + loader（构建期）+ 运行时入口 bundle.ts
  generated/                 # ★ 构建产物（gitignore）：content.json / content.index.json / config.json
  db/schema.ts               # Drizzle ORM 映射（与 0001_init.sql 的对拍见 tests/contract）
scripts/
  build-content.ts           # YAML + config → src/generated/（predev/prebuild 调用）
  oracle/dump_fixtures.py    # Python 侧 dump 对拍黄金语料（S6 随 Python 一起删）
app/ components/ lib/        # Next.js 16 App Router + TS + Tailwind + Framer Motion（仓库根）
tools/
  demo_p0.py                 # P0 端到端演示
  simulate.py                # 7 画像 × 30 天模拟体检
  init_db.py                 # 建库（读 build/content_dump.json）
  content_cli/               # 内容工作台
tests/
  oracle/fixtures/           # ★ 对拍黄金语料（提交进仓库 —— Python 删除后是唯一基准）
  unit/ contract/ acceptance/
docs/
  api-contract.md            # 前后端契约（端点的唯一事实来源）
  开发计划-V1.2.md
  adr/                       # 不可随意修改的架构决策
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

---

## 下一步（需要产品判断，不是工程 bug）

1. **迁移探针的阈值语义**：升级要求 `transfer ≥ 0.8`，但探针考的是**从没练过的
   pattern**（`prefer_untried_pattern`）。模拟里「快但脆型」30 天 transfer=0.0
   ——探针全错，升级被卡死。三个方向：探针先给一次示范再考 / transfer 改按
   新结构下的一般正确率计 / 降阈值 + 多次采样取均值。
2. **内容 d4 债**（`make content-lint` 的 10 条警告，非阻塞）：`make_ten` 与
   `sd_add_10` 的槽声明上限 d4 但内容最高 d3；`st09` 三个故事槽绑 `increase`
   而 blocks/direct 层没有该 pattern 的题。
3. **家长报告要配"最近趋势"**：等级是 EWMA 派生值，只记最近十几次作答。
   模拟里「平台型」显示 ⭐ 熟练而其 30 天均值只有 0.68 —— 只给等级会误导家长。
4. **跨能力难度标尺不连续**：难度是能力内标尺，换能力时会出现 +2 跳变。要做
   全局连续需要重做难度定义。

完整进度与每次修复的实测数字见 `docs/开发计划-V1.2.md` 与 `tools/simulate.py`
的体检报告（`make simulate`）。
