# API 契约 v1（冻结）

> 前端与后端并行开发的唯一接口依据。
> 契约以本文件为准；如需变更，先改本文件再改两端代码。

Base URL：`/v1`
数据格式：JSON（UTF-8）
认证：MVP 不做账号体系。所有请求通过 `child_id` 指明孩子，缺省使用默认孩子。

---

## 0. 全局约定

### 答案不下发
题目载荷**不包含答案**。前端提交原始作答值，由服务端判定并返回反馈。

- 选择题等前端可自行判定的题型，前端可额外上报 `client_correct`；
- 服务端独立判定，不一致时记录 `judgement_mismatch`（ADR-0004 双轨判定）；
- 判断题/数字题的 `client_correct` 留空即可。

### 幂等
`POST /v1/attempts` 必须带 `client_attempt_id`（前端生成的 UUID）。服务端以
`(child_id, client_attempt_id)` 做幂等键：重复提交返回首次结果，不重复写入。
断网重试、页面刷新重放都靠这个机制保证"孩子做对了就一定有学习记录"。

### 时间语义（ADR-0003）
前端必须上报三项，且**不得**把"超过 N 秒无操作"直接算作无效：

```json
"telemetry": {
  "response_time_ms": 9200,   // 题目出现 → 提交答案
  "active_time_ms": 1200,     // 实际鼠标 / 触摸 / 键盘操作时间
  "idle_time_ms": 0           // 被判定为"疑似离开"的分段之和（>30s 的停顿）
}
```

`thinking_time_ms` 由服务端计算（= response − active − idle），前端不要上报。

---

## 1. 首页数据

### `GET /v1/world?child_id=1`

```json
{
  "child": { "id": 1, "name": "小明" },
  "today": {
    "headline": "小熊的桥坏啦！",
    "subtitle": "去数字车站帮它一把",
    "story_code": "ns_01_first_day",
    "universe_code": "number_station",
    "estimated_minutes": 12,
    "completed": false
  },
  "universes": [
    {
      "code": "number_station",
      "name": "数字车站",
      "emoji": "🚂",
      "unlocked": true,
      "progress": 0.35,
      "stories": [
        { "code": "ns_01_first_day", "title": "小站第一天", "completed": true, "unlocked": true },
        { "code": "ns_02_ticket", "title": "小兔买车票", "completed": false, "unlocked": true }
      ]
    },
    {
      "code": "detective",
      "name": "侦探社",
      "emoji": "🦊",
      "unlocked": false,
      "progress": 0.0,
      "stories": []
    }
  ],
  "lab_unlocked": true,
  "detective_unlocked": false,
  "growth_summary": {
    "materials": {"wood": 12, "coin": 8, "gem": 1, "seed": 3},
    "buildings": ["ticket_booth"],
    "newest_badge": { "code": "first_make_ten", "name": "第一次凑十", "emoji": "🎖️" }
  }
}
```

---

## 2. 学习会话

### `POST /v1/sessions`

```json
{ "child_id": 1, "planned_minutes": 12, "device": "web" }
```

→

```json
{ "session_id": 3, "started_at": "2026-09-15T10:00:00Z" }
```

### `POST /v1/sessions/{session_id}/end`

```json
{ "quit_reason": "completed" }   // completed | child_quit | timeout | error
```

→ `{ "ok": true }`

---

## 3. 今日计划

### `GET /v1/plans/today?child_id=1&session_id=3`

时间预算是硬约束，题量不是。

```json
{
  "child_id": 1,
  "budget_minutes": 12,
  "intents": [
    { "kind": "teach", "competency": "make_ten", "reason": "当前聚焦能力尚未达标" }
  ],
  "segments": [
    {
      "type": "warmup",
      "budget_s": 154,
      "intent_kinds": [],
      "slot_code": null,
      "scaffold_level": null,
      "items": [],
      "note": "本段今日无意图"
    },
    {
      "type": "core",
      "budget_s": 309,
      "intent_kinds": ["teach"],
      "slot_code": "core_make_ten_practice",
      "scaffold_level": "direct",
      "items": [
        {
          "code": "mt_dir_8_5",
          "competency": "make_ten",
          "pattern": "direct_compute",
          "difficulty": 3,
          "scaffold_level": "direct",
          "interaction_type": "number_pad",
          "estimated_seconds": 6,
          "prompt": "8 + 5 = ?",
          "problem": { "a": 8, "b": 5 },
          "answer_type": "number",
          "choices": null,
          "hints_available": 2
        }
      ],
      "note": ""
    },
    { "type": "story", "budget_s": 240, "intent_kinds": [], "slot_code": null,
      "scaffold_level": null, "story_code": "ns_01_first_day",
      "beats": [
        { "beat_code": "ns_01_first_day__beat_2", "slot_code": "ns_01_beat_2", "item_code": "mt_blk_8_5" }
      ],
      "items": [], "note": "" },
    { "type": "thinking", "budget_s": 185, "items": [], "note": "本段今日无意图" },
    { "type": "discovery", "budget_s": 72, "items": [], "note": "" }
  ],
  "discovery": "今天你发现了：凑十，第一次还要用积木摆，现在可以直接算了。",
  "notes": []
}
```

**segment 可选字段（仅 story 段有，其余段为 null / 空数组）**

| 字段 | 说明 |
|---|---|
| `story_code` | string \| null。本段对应的故事 code；非故事段为 `null` |
| `beats` | `[{beat_code, slot_code, item_code}]`。每个挑战节拍配到的题目映射 |

故事播放器**逐 beat 出题时必须使用 `beats` 映射**，不要靠 `items` 数组下标隐式对齐
—— 某个节拍落不到题时，下标会整体错位。`beat_code` 即 `GET /v1/stories/{code}`
响应里的 beat 序号（`{story_code}__{local}`）。

**Item 载荷（所有出现 item 的地方形状一致）**

| 字段 | 说明 |
|---|---|
| `code` | 题目唯一标识 |
| `competency` / `pattern` | 能力与问题结构 |
| `difficulty` | 1～5 |
| `scaffold_level` | `blocks` / `decompose` / `direct` |
| `interaction_type` | `number_pad` / `choice` / `blocks` / `decompose_drag` / `carry_exchange` / `number_line` |
| `estimated_seconds` | 期望耗时 |
| `prompt` | 给孩子看的题面 |
| `problem` | 结构化参数，供交互组件渲染（如 `{"a":8,"b":5,"target":10}`）|
| `answer_type` | `number` / `choice` |
| `choices` | `answer_type=choice` 时的选项数组，否则 `null` |
| `hints_available` | 可用的提示级数（提示文本由 `/v1/coach/hints` 取）|

### Item.choices 的来源（现状与迁移方向）

choice 交互的选项**应当**来自内容层显式声明的 `item.choices`。

**现状**：内容层（content/items/*.yaml）还没有 `choices` 字段。运行时由服务端从
`error_rules` 的 `answer_in` / `answer_equals`（典型错法集合）反推"常见错法"，
与正确答案合并去重后作为选项下发（`backend/service/content.py::choices_for`）。
因此选项集合取决于该题 error_rules 的覆盖度，不保证稳定。

**迁移方向**：内容层为 choice 题补上显式 `choices` 声明后，`choices_for` 改为
优先读 `item.choices`，error_rules 反推降级为兜底。契约形状不变（整数数组）。

---

## 4. 提交作答（学习系统唯一事实入口）

### `POST /v1/attempts`

```json
{
  "client_attempt_id": "8f14e45f-ea0f-4b1c-9c1e-2f5b0f1a9d33",
  "child_id": 1,
  "session_id": 3,
  "item_code": "mt_blk_8_5",
  "slot_code": "ns_01_beat_2",
  "answer": 12,
  "client_correct": null,
  "hints_used": 0,
  "hint_level_max": 0,
  "method_used": null,
  "is_transfer_probe": false,
  "telemetry": { "response_time_ms": 8800, "active_time_ms": 1400, "idle_time_ms": 0 }
}
```

`method_used` 可选：`counting` / `decompose` / `make_ten` / `mental` / `written` / `visual_blocks` / `number_line`

→

```json
{
  "attempt_id": 42,
  "seq": 42,
  "duplicate": false,
  "correct": false,
  "judgement_mismatch": false,
  "misconceptions": ["counting_dependency"],
  "feedback": {
    "tone": "repair",
    "text": "糟糕，小熊把一个十藏起来了！我们找一找十位在哪里。",
    "character": "xiong"
  },
  "reward": {
    "materials": [{ "code": "wood", "count": 1 }],
    "coins": 1,
    "unlocks": []
  },
  "progress": {
    "competency": "make_ten",
    "level": "encountering",
    "level_label": "🌱 接触",
    "scaffold_level": "blocks",
    "signals": { "mastery": 0.0, "accuracy": 0.0, "fluency": null,
                 "independence": 1.0, "transfer": null },
    "sample_count": 1
  },
  "next": { "kind": "next_item", "beat_index": null, "item": null }
}
```

- `feedback.tone`：`praise`（对了）/ `encourage`（对了但费劲）/ `repair`（错了，剧情化处理）
- `progress` 供调试面板与家长端使用，**儿童 UI 不展示 mastery 数值**
- `reward` 与 attempt 在同一事务内写入

---

## 5. AI 教练提示

### `POST /v1/coach/hints`

```json
{ "child_id": 1, "item_code": "mt_blk_8_5", "hints_used": 0, "last_answer": 12 }
```

→

```json
{
  "hint_level": 1,
  "hint_text": "8 再添几个就满十格框了？",
  "source": "rule",
  "fallback_used": false,
  "exhausted": false
}
```

- `source`：`rule` / `llm`
- LLM 不可用或校验失败时自动回退，`fallback_used=true`，`source="rule"`
- `hint_level` 超过 `hints_available` 时 `exhausted=true`，`hint_text` 为鼓励语
- 硬约束：一次只说**一个动作 + 一句鼓励**，不得出现答案

---

## 6. 故事

### `GET /v1/stories/{story_code}?child_id=1`

```json
{
  "code": "ns_01_first_day",
  "universe": "number_station",
  "title": "小站第一天",
  "duration_min": 6,
  "order_index": 1,
  "beats": [
    {
      "index": 1,
      "type": "narration",
      "narration": "清晨，数字车站醒过来了。今天是小熊站长第一天上班。",
      "visual": { "kind": "station", "mood": "morning", "characters": ["xiong"] },
      "reward": null,
      "challenge": null
    },
    {
      "index": 2,
      "type": "challenge",
      "narration": "先要把站台上的行李数清楚。",
      "visual": { "kind": "luggage", "mood": "calm" },
      "reward": null,
      "challenge": {
        "slot_code": "ns_01_beat_2",
        "purpose": "practice",
        "scaffold_level": "blocks",
        "item": { "...": "Item 载荷，形状同上" }
      }
    },
    {
      "index": 3,
      "type": "reward",
      "narration": "行李都数清楚啦！小熊捡到一块木板。",
      "visual": { "kind": "station", "mood": "happy" },
      "reward": { "materials": [{ "code": "wood", "count": 2 }], "coins": 1, "unlocks": [] },
      "challenge": null
    }
  ]
}
```

`visual.kind` 取值（前端据此选插画组件）：
`station` / `luggage` / `train` / `ticket` / `repair` / `box` / `night` / `shop` / `build` / `detective` / `animal`

---

## 7. 数学实验室

### `GET /v1/lab?child_id=1`

实验共 **7 个**（含 `borrow_exchange` 退位交换）。

```json
{
  "experiments": [
    { "code": "blocks", "name": "数字积木", "emoji": "🧱", "description": "把一个数摆成几个十和几个一", "component": "blocks_lab", "unlocked": true },
    { "code": "decompose", "name": "拆分数字", "emoji": "✂️", "description": "23 可以拆成 20 和 3，也可以拆成别的", "component": "decompose_lab", "unlocked": true },
    { "code": "make_ten", "name": "凑十", "emoji": "🔟", "description": "8+5 → 8+2+3", "component": "make_ten_lab", "unlocked": true },
    { "code": "place_value_train", "name": "十位小火车", "emoji": "🚃", "description": "十位车厢和个位车厢分开跑", "component": "place_value_train_lab", "unlocked": true },
    { "code": "carry_exchange", "name": "进位交换", "emoji": "🔁", "description": "10 个一换 1 个十，看看车厢怎么变", "component": "carry_exchange_lab", "unlocked": false },
    { "code": "borrow_exchange", "name": "退位交换", "emoji": "🔓", "description": "拆开 1 个十，换成 10 个一", "component": "borrow_exchange_lab", "unlocked": false },
    { "code": "shape_build", "name": "图形搭建", "emoji": "🔺", "description": "用小棒搭出各种图形（为几何做准备）", "component": "shape_build_lab", "unlocked": false }
  ]
}
```

- `component`：前端渲染该实验使用的交互组件名（来自 `config/lab/v0.yaml`）
- 解锁规则：`unlock` 为空 → 一直可用；否则要求指定能力达到指定等级
  （等级由服务端按 `derive_level` 现算）

实验室为自由探索，**不计入熟练度状态**。

---

## 8. 数学侦探

### `GET /v1/detective/puzzle?child_id=1`

```json
{
  "puzzle_id": "det_0007",
  "kind": "guess_number",
  "prompt": "我想了一个数字。",
  "clues": [
    { "text": "它大于 20", "revealed": true },
    { "text": "它小于 40", "revealed": true },
    { "text": "它是偶数", "revealed": false },
    { "text": "它的个位是 6", "revealed": false }
  ],
  "candidates": [26, 28, 36, 38],
  "answer_type": "number",
  "clues_remaining": 2
}
```

### `POST /v1/detective/answer`

```json
{ "child_id": 1, "puzzle_id": "det_0007", "answer": 26, "client_attempt_id": "..." }
```

→ `{ "correct": true, "feedback": {...}, "revealed_clues": ["它是偶数"], "reward": {...} }`

---

## 9. 成长

### `GET /v1/growth?child_id=1`

```json
{
  "tree": {
    "nodes": [
      { "code": "make_ten", "name": "凑十", "level": "proficient", "level_label": "⭐ 熟练",
        "mastered": false, "emoji": "🔟", "unlocked": true, "position": { "x": 0, "y": 1 } },
      { "code": "place_value", "name": "十位与个位", "level": "can_do", "level_label": "🌳 会做",
        "mastered": false, "emoji": "🚃", "unlocked": true, "position": { "x": 2, "y": 1 } }
    ],
    "edges": [ { "from": "sd_add_10", "to": "make_ten" } ]
  },
  "materials": { "wood": 12, "coin": 8, "gem": 1, "seed": 3 },
  "buildings": [
    { "code": "ticket_booth", "name": "售票亭", "emoji": "🎫", "built": true,
      "cost": { "wood": 5, "coin": 2 } },
    { "code": "platform", "name": "站台", "emoji": "🛤️", "built": false,
      "cost": { "wood": 10, "coin": 5 } }
  ],
  "badges": [
    { "code": "first_make_ten", "name": "第一次凑十", "emoji": "🎖️", "earned": true, "earned_at": "..." }
  ]
}
```

### `POST /v1/growth/build`

```json
{ "child_id": 1, "building_code": "platform" }
```

→ `{ "built": true, "materials": {"wood": 2, "coin": 3, "gem": 1, "seed": 3}, "unlocks": ["universe.detective"] }`

`built=false` 且带 `reason` 表示材料不足。

---

## 10. 家长端

### `GET /v1/parent/report?child_id=1&days=7`

```json
{
  "child": { "id": 1, "name": "小明" },
  "range": { "days": 7, "from": "2026-09-08", "to": "2026-09-15" },
  "headline": "本周不是「不会两位数加法」，而是「已经理解，但流畅度不足」。",
  "competencies": [
    { "code": "sd_add_10", "name": "10 以内加法", "level": "automatic", "level_label": "🔥 自动化",
      "score": 0.95, "signals": {"mastery":0.97,"accuracy":0.98,"fluency":0.91,"independence":0.99,"transfer":0.9} },
    { "code": "make_ten", "name": "凑十", "level": "can_do", "level_label": "🌳 会做",
      "score": 0.61, "signals": {"mastery":0.72,"accuracy":0.68,"fluency":0.55,"independence":0.94,"transfer":0.7} }
  ],
  "weak_points": [
    { "type": "fluency", "competency": "make_ten",
      "text": "能独立做对，但每次要多想几秒；建议继续用「先凑十」的方法，不要退回逐个数。" }
  ],
  "misconceptions": [
    { "code": "counting_dependency", "name": "依赖数数", "hit_count": 3,
      "text": "近一周出现 3 次逐个数的情况。" }
  ],
  "progress": [
    { "date": "2026-09-09", "level": "understanding", "note": "第一次在提示下完成凑十" },
    { "date": "2026-09-13", "level": "can_do", "note": "不用积木也能拆分了" }
  ],
  "engagement": {
    "sessions": 5,
    "total_minutes": 58,
    "avg_minutes_per_session": 11.6,
    "next_day_return_rate": 0.8,
    "story_completion_rate": 0.75
  },
  "advice": [
    "每天 10～15 分钟即可，不要延长。",
    "本周重点是「快一点」，可以玩「限时凑十」，但不要催。"
  ],
  "disclaimer": "数据来自孩子在应用内的真实作答，仅供家庭参考，不作为学业评价。"
}
```

---

## 11. 调试（仅开发环境）

### `GET /v1/debug/learning-state?child_id=1`

返回全部 competency / pattern 的原始信号、样本数、等级、`algorithm_version`。
前端在 URL 带 `?debug=1` 时展示一个折叠面板。

---

## 12. 错误格式

所有非 2xx：

```json
{ "error": { "code": "ITEM_NOT_FOUND", "message": "mt_blk_8_5 不存在" } }
```

状态码：`400` 参数错误 / `404` 资源不存在 / `409` 冲突 / `500` 服务端错误。
可重试的：`5xx`、网络错误。**不可重试**：`4xx`（除 429）。
