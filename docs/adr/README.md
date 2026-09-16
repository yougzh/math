# ADR：架构决策记录

本目录记录**不可随意修改**的架构决策。

## 规则

1. 一个决策一个文件，命名 `NNNN-短名.md`
2. 决策一旦记录，视为冻结。要改动必须**新写一个 ADR 覆盖旧的**，不允许直接编辑旧 ADR
3. 代码、文档、评审意见与 ADR 冲突时，**以 ADR 为准**
4. 每条 ADR 必须写明：背景 / 决策 / 后果 / 违反时的表现

## 索引

| 编号 | 决策 | 状态 |
|---|---|---|
| [0001](0001-story-challenge-slot.md) | 故事通过 Challenge Slot 与题目解耦 | 已接受 |
| [0002](0002-proficiency-level-is-derived.md) | 熟练度等级是派生值，不落库为权威 | 已接受 |
| [0003](0003-thinking-time-is-not-idle.md) | 思考时间不是无效时间（时间语义冻结） | 已接受 |
| [0004](0004-attempt-is-the-only-fact-entry.md) | Attempt 是学习系统唯一事实入口 | 已接受 |
| [0005](0005-detective-attempts-are-not-learning-facts.md) | 侦探答题不是学习事实 | 已接受 |
