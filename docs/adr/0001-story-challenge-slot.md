# ADR-0001：故事通过 Challenge Slot 与题目解耦

- 状态：已接受
- 日期：2026-09-15
- 取代：无

## 背景

早期设计是 `Story → Item`：故事节点直接绑定固定题目。

这会导致：

- 同一个故事对水平高的孩子太简单、对水平低的孩子太难
- 自适应失效——Planner 无法在故事内部调整难度
- 想换一道题就必须改故事，内容维护成本随故事数线性增长

## 决策

在 `story_beat` 与 `item` 之间引入 **`challenge_slot` 一等实体**（独立成表，不是 JSON 字段）。

```
Story → Challenge Slot → Item Selection → Item
```

三层职责，不允许越界：

| 层 | 回答的问题 | 不允许做的事 |
|---|---|---|
| Story | 为什么做 | 不允许指定具体题目 |
| Challenge Slot | 练什么（pattern + 难度区间 + 策略 + 脚手架级别） | 不允许指定具体题目 |
| Planner / Item Selector | 具体做哪一道 | 不允许改变故事与 slot 的语义 |

`challenge_slot` 必须包含：

```
competency_id, pattern_id,
difficulty_min, difficulty_max,
selection_policy,   # 候选过滤 / 排序 / 轮换
review_policy,      # 复习与迁移要求
estimated_time_s,
scaffold_level,     # blocks | decompose | direct
purpose             # teach | practice | review | challenge
```

运行时：

```
Planner → ChallengeSlot → Candidate Items → Filter → Rank → Select Item
```

## 后果

**正面**

- 故事固定，数学训练动态：同一句"小熊需要把篮子装满"，强孩子拿 `8+5`，弱孩子拿 `7+3`，更弱的孩子拿到带积木脚手架的题
- 策略可在 slot 上表达而不改故事，例如"这里必须是 make_ten，但孩子最近连续做过 make_ten 就换 decompose"
- 故事成为纯内容资产，可以被复用到不同能力阶段

**代价**

- 需要 Item Selector 与候选池，P0 必须实现 `selector.py`
- 内容生产时必须保证每个 slot 的候选池非空（Content Compiler 强制校验）
- 故事无法再"手工安排某一道精妙的题"——这是有意放弃的表达力

## 违反时的表现（自检）

- 出现 `story_beat.item_id` 字段 → 违反
- 故事 YAML 里出现具体数字/题目字面量 → 违反
- 为了让孩子遇到某道特定题而改故事文件 → 违反
