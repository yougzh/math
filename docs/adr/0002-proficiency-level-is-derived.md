# ADR-0002：熟练度等级是派生值，不落库为权威

- 状态：已接受
- 日期：2026-09-15
- 取代：无

## 背景

熟练度等级（🌱 接触 / 🌿 理解 / 🌳 会做 / ⭐ 熟练 / 🔥 自动化）是最容易被写成数据库字段的东西：

```sql
proficiency_state(child_id, competency_id, level)   -- ❌
```

一旦这样写，等级就成了权威事实。之后任何算法调整都无法回溯历史——因为"当初为什么判成 ⭐"已经丢失，只剩一个结论。

## 决策

数据库只保存**原始信号 + 样本数 + 算法版本**：

```
proficiency_state(
  child_id, competency_id,
  mastery, accuracy, fluency, independence, transfer, confidence,
  sample_count,
  probe_status,
  algorithm_version      # 关键：这条状态是哪个版本的算法算出来的
)
```

等级永远是派生值：

```python
level = derive_level(state, config_for(algorithm_version))
```

由此得到 Replay 能力：

```
algorithm v0 → algorithm v1 → replay → 重新计算全部 level
```

## 后果

**正面**

- 改算法后可以整表重算，不产生历史脏数据
- 可以拿同一批历史数据对比 v0 / v1 的判定差异，用来调参
- 等级判定逻辑是纯函数，可单元测试、可解释

**代价**

- 每次展示等级都要计算（可接受：一次纯函数调用，必要时缓存但缓存不是权威）
- `algorithm_version` 必须随每条状态写入，未 pin 版本的历史数据视为不可信
- 阈值必须全部走配置，禁止硬编码（见 `config/algorithm/*.yaml`）

## 违反时的表现（自检）

- 数据库里出现 `level` 字段并被当作真值读取 → 违反
- 代码里出现 `if accuracy > 0.9:` 这种字面量阈值 → 违反
- 状态更新时不写 `algorithm_version` → 违反
