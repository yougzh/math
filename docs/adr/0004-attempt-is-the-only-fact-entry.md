# ADR-0004：Attempt 是学习系统唯一事实入口

- 状态：已接受
- 日期：2026-09-15
- 取代：无

## 背景

学习状态的更新有多条可能的写入路径：前端算完直接改、批量导入、后端定时任务、管理后台手工修正。路径一多，"孩子做对了但没记录"就一定会发生，而且无法定位。

## 决策

**唯一入口：`POST /v1/attempts`。** 其余任何路径都不得写学习状态。

服务端事务（硬要求）：

```
BEGIN
  insert attempt               -- 快照：便于查询
  insert learning_event        -- append-only：便于回放
  insert game_event / reward_log
  update proficiency_state / pattern_state / misconception_state / review_schedule
COMMIT
```

语义保证：**孩子做对了，就一定有学习记录。**

两条配套规则：

1. **前端不得直接修改学习状态。** 路由层做显式白名单，任何可写学习状态的接口都只能由 attempt 链路触发。
2. **前端判定与后端判定分离（双轨）。** 前端可即时显示"答对啦 🎉"以保体验，但后端必须独立复核 `answer / item / solution` 并以此计算 `correct / error_type / proficiency update`。两者不一致时写 `judgement_mismatch` 标记。

引入 Outbox 的时机：**奖励需要异步处理时**，不是 P0。

## 后果

**正面**

- 学习数据 100% 可回放，一次事务保证一致性
- 出现"数据对不上"时只有一条链路需要排查
- `judgement_mismatch` 成为可观测指标，能发现前端判题 bug

**代价**

- 提交失败必须处理：前端本地缓存 attempt，恢复后重放；需要幂等键防止重复写入
- 事务里做了状态更新，写入路径较长，需要监控 `attempt_save_success`
- 奖励逻辑不能随意加外部调用（如发消息），否则事务被拖长

## 违反时的表现（自检）

- 出现绕过 attempt 直接更新 `proficiency_state` 的代码 → 违反
- 前端调用某个"提升等级"接口 → 违反
- attempt 写入成功但 state 更新失败（非同一事务） → 违反
