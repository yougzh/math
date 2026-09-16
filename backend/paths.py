"""项目路径常量。

集中定义，避免各模块用 os.path 层层回溯。
"""
from __future__ import annotations

import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CONFIG_DIR = os.path.join(ROOT, "config")
ALGORITHM_CONFIG_DIR = os.path.join(CONFIG_DIR, "algorithm")

CONTENT_DIR = os.path.join(ROOT, "content")
COMPETENCY_DIR = os.path.join(CONTENT_DIR, "competencies")
PATTERN_DIR = os.path.join(CONTENT_DIR, "patterns")
ITEM_DIR = os.path.join(CONTENT_DIR, "items")
MISCONCEPTION_DIR = os.path.join(CONTENT_DIR, "misconceptions")
STORY_DIR = os.path.join(CONTENT_DIR, "stories")
SLOT_DIR = os.path.join(CONTENT_DIR, "slots")
