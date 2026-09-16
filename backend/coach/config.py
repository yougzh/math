"""教练文案配置。与算法配置分开：算法决定"推什么"，教练决定"怎么说"。"""
from __future__ import annotations

import os
from functools import lru_cache
from typing import Any, Dict, List

import yaml

from backend.paths import CONFIG_DIR

COACH_CONFIG_DIR = os.path.join(CONFIG_DIR, "coach")


class CoachConfig:
    def __init__(self, data: Dict[str, Any]):
        self.data = data
        self.version = int(data.get("version", 0))

    # ── 限额 ──────────────────────────────────────────────
    @property
    def max_chars(self) -> int:
        return int(self.data.get("limits", {}).get("max_chars", 42))

    @property
    def max_sentences(self) -> int:
        return int(self.data.get("limits", {}).get("max_sentences", 2))

    @property
    def max_exclamation_marks(self) -> int:
        return int(self.data.get("limits", {}).get("max_exclamation_marks", 1))

    # ── 语气 ──────────────────────────────────────────────
    def forbidden_phrases(self) -> List[str]:
        return list(self.data.get("tone_forbidden_phrases", []) or [])

    def openers(self, tone: str) -> List[str]:
        return list((self.data.get("tone_openers", {}) or {}).get(tone, []) or [])

    def feedback_texts(self, key: str) -> List[str]:
        row = (self.data.get("feedback_templates", {}) or {}).get(key, {}) or {}
        return list(row.get("texts", []) or [])

    def feedback_tone(self, key: str, default: str = "encourage") -> str:
        row = (self.data.get("feedback_templates", {}) or {}).get(key, {}) or {}
        return row.get("tone", default)

    def concept_prompt(self, competency_id: str) -> str:
        return (self.data.get("concept_prompts", {}) or {}).get(competency_id, "")


@lru_cache(maxsize=8)
def load_coach_config(version: int = 0) -> CoachConfig:
    path = os.path.join(COACH_CONFIG_DIR, "v{}.yaml".format(version))
    with open(path, "r", encoding="utf-8") as fh:
        return CoachConfig(yaml.safe_load(fh) or {})
