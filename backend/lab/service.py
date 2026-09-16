"""数学实验室：自由探索区。

三条设计约束，都写在代码里而不是靠自觉：

1. **不计入熟练度**。这里的返回结构里没有 answer，也没有 attempt ——
   实验室故意不产生学习事件。孩子在这里"玩"，不在"考"。

2. **前几个实验没有门槛**。探索区如果一进门全是锁，孩子就走了。
   配置里 unlock 为 null 的实验对所有孩子开放。

3. **解锁靠能力等级，不靠年级/天数**。这是自适应的延伸：
   孩子什么时候能玩"进位交换"，取决于他什么时候真的理解了位值。
"""
from __future__ import annotations

import os
from functools import lru_cache
from typing import Any, Callable, Dict, List, Optional

import yaml

from backend.paths import CONFIG_DIR

LAB_CONFIG_DIR = os.path.join(CONFIG_DIR, "lab")

# level_of(competency_code) -> level 字符串（由调用方用 derive_level 提供）
LevelLookup = Callable[[str], str]


class LabConfig:
    def __init__(self, data: Dict[str, Any]):
        self.data = data
        self.version = int(data.get("version", 0))

    @property
    def experiments(self) -> List[Dict[str, Any]]:
        return list(self.data.get("experiments", []) or [])


@lru_cache(maxsize=4)
def load_lab_config(version: int = 0) -> LabConfig:
    path = os.path.join(LAB_CONFIG_DIR, "v{}.yaml".format(version))
    with open(path, "r", encoding="utf-8") as fh:
        return LabConfig(yaml.safe_load(fh) or {})


def _meets(level: str, min_level: str, level_order: List[str]) -> bool:
    if level not in level_order or min_level not in level_order:
        # 等级名写错时宁可开着，也不要因为配置笔误把孩子锁在门外
        return True
    return level_order.index(level) >= level_order.index(min_level)


def is_unlocked(
    experiment: Dict[str, Any],
    level_of: LevelLookup,
    level_order: List[str],
) -> bool:
    unlock = experiment.get("unlock")
    if not unlock:
        return True
    competency = unlock.get("competency")
    if not competency:
        return True
    return _meets(level_of(competency), unlock.get("min_level", "understanding"), level_order)


def list_experiments(
    level_of: LevelLookup,
    level_order: List[str],
    config: Optional[LabConfig] = None,
) -> List[Dict[str, Any]]:
    """返回契约 §7 里 `experiments` 的数组。"""
    config = config or load_lab_config(0)
    out = []
    for experiment in config.experiments:
        out.append(
            {
                "code": experiment.get("code"),
                "name": experiment.get("name", experiment.get("code")),
                "emoji": experiment.get("emoji", "🧩"),
                "description": experiment.get("description", ""),
                "component": experiment.get("component", ""),
                "unlocked": is_unlocked(experiment, level_of, level_order),
            }
        )
    return out
