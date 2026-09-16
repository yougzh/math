"""内容 YAML 的 JSON Schema。

给编辑器和 CI 用，让人在写 YAML 时就能看见字段拼错，而不是等编译器报错。
Schema 只描述"结构"，不描述"认知有效性"—— 后者必须靠 cognitive.py 里的代码检查。
"""
from __future__ import annotations

from typing import Any, Dict

SCAFFOLD_ENUM = ["blocks", "decompose", "direct", "auto"]

COMPETENCY_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "required": ["competencies"],
    "properties": {
        "competencies": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["code", "name", "stage", "prerequisites"],
                "properties": {
                    "code": {"type": "string", "pattern": "^[a-z0-9_]+$"},
                    "name": {"type": "string"},
                    "stage": {"type": "integer", "minimum": 1},
                    "prerequisites": {"type": "array", "items": {"type": "string"}},
                    "notes": {"type": "string"},
                },
            },
        }
    },
}

PATTERN_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "required": ["patterns"],
    "properties": {
        "patterns": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["code", "name", "cognitive_type", "applicable_competencies"],
                "properties": {
                    "code": {"type": "string", "pattern": "^[a-z0-9_]+$"},
                    "name": {"type": "string"},
                    "cognitive_type": {
                        "enum": ["compute", "represent", "strategy", "apply", "reverse"]
                    },
                    "applicable_competencies": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                    "notes": {"type": "string"},
                },
            },
        }
    },
}

MISCONCEPTION_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "required": ["misconceptions"],
    "properties": {
        "misconceptions": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["code", "name", "remediation_competency"],
                "properties": {
                    "code": {"type": "string", "pattern": "^[a-z0-9_]+$"},
                    "name": {"type": "string"},
                    "remediation_competency": {"type": "string"},
                    "notes": {"type": "string"},
                },
            },
        }
    },
}

ITEM_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "required": ["items"],
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "required": [
                    "code", "competency", "pattern", "difficulty",
                    "scaffold_level", "interaction_type", "problem", "answer",
                ],
                "properties": {
                    "code": {"type": "string", "pattern": "^[a-z0-9_]+$"},
                    "competency": {"type": "string"},
                    "pattern": {"type": "string"},
                    "difficulty": {"type": "integer", "minimum": 1, "maximum": 5},
                    "scaffold_level": {"enum": SCAFFOLD_ENUM},
                    "interaction_type": {"type": "string"},
                    "estimated_seconds": {"type": "integer", "minimum": 1},
                    "problem": {"type": "object"},
                    "answer": {"type": "integer"},
                    "steps": {"type": "array", "items": {"type": "string"}},
                    "steps_style": {"enum": ["guide", "conclude"]},
                    "hint_chain": {"type": "array", "items": {"type": "string"}},
                    "error_rules": {"type": "array", "items": {"type": "object"}},
                },
            },
        }
    },
}

SLOT_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "required": ["slots"],
    "properties": {
        "slots": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["code", "competency", "purpose"],
                "properties": {
                    "code": {"type": "string", "pattern": "^[a-z0-9_]+$"},
                    # 关键：story_beat 可以为空 —— 空 = 独立训练槽（不依附故事）
                    "story_beat": {"type": ["string", "null"]},
                    "competency": {"type": "string"},
                    "pattern": {"type": ["string", "null"]},
                    "purpose": {
                        "enum": [
                            "warmup", "core", "practice", "story",
                            "thinking", "challenge", "review", "probe",
                        ]
                    },
                    "difficulty_min": {"type": "integer", "minimum": 1, "maximum": 5},
                    "difficulty_max": {"type": "integer", "minimum": 1, "maximum": 5},
                    "scaffold_level": {"enum": SCAFFOLD_ENUM},
                    "estimated_seconds": {"type": "integer", "minimum": 1},
                    "selection_policy": {"type": "object"},
                    "review_policy": {"type": "object"},
                },
            },
        }
    },
}

STORY_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "required": ["story"],
    "properties": {
        "story": {
            "type": "object",
            "required": ["code", "title", "universe", "beats"],
            "properties": {
                "code": {"type": "string"},
                "title": {"type": "string"},
                "universe": {"type": "string"},
                "summary": {"type": "string"},
                "beats": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["code", "order", "kind", "text"],
                        "properties": {
                            "code": {"type": "string"},
                            "order": {"type": "integer"},
                            "kind": {"enum": ["story", "challenge", "reward"]},
                            "text": {"type": "string"},
                            "character": {"type": "string"},
                        },
                    },
                },
            },
        }
    },
}

ALL_SCHEMAS: Dict[str, Dict[str, Any]] = {
    "competency": COMPETENCY_SCHEMA,
    "pattern": PATTERN_SCHEMA,
    "misconception": MISCONCEPTION_SCHEMA,
    "item": ITEM_SCHEMA,
    "slot": SLOT_SCHEMA,
    "story": STORY_SCHEMA,
}
