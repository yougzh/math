"""规则版教练：不依赖任何模型，离线也能说话。

它负责两件事：
  1. 挑下一级提示（来自 item.hint_chain，逐级给出，不跳级）
  2. 给反馈（对/错/用提示/慢但对/命中误区）

LLM 只能**改写**这里的文案，不能自己决定说什么 —— 因为说什么受教学法约束，
怎么写才自然才是语言模型擅长的。这个分工让系统在模型不可用时依然完整。
"""
from __future__ import annotations

from typing import Dict, List, Optional

from backend.coach.config import CoachConfig
from backend.content.loader import ContentBundle, Item


def next_hint_level(hints_used: int, item: Item) -> int:
    """提示按级给，不跳级。提示链用完了返回 0，表示"该换一种帮法"。"""
    total = len(item.hint_chain)
    if total == 0 or hints_used >= total:
        return 0
    return hints_used + 1


def hint_text(item: Item, level: int) -> str:
    if level <= 0 or level > len(item.hint_chain):
        return ""
    return str(item.hint_chain[level - 1])


def _pick(options: List[str], seed: int) -> str:
    """确定性挑选：同一个孩子同一道题不会每次看到不同开场词。"""
    if not options:
        return ""
    return options[seed % len(options)]


def build_hint_rule_text(
    item: Item,
    hints_used: int,
    cfg: CoachConfig,
    misconception_code: Optional[str] = None,
) -> Dict[str, object]:
    """规则版提示：先给误区指向的概念，再给 hint_chain 的下一级。"""
    level = next_hint_level(hints_used, item)
    text = hint_text(item, level)
    if not text:
        # 提示链用完了：退回到该能力的通用思维提示，而不是放弃
        text = cfg.concept_prompt(item.competency_id) or "先把题目再读一遍。"
        level = 0
    return {
        "tone": "encourage",
        "text": text,
        "level": level,
        "exhausted": level == 0,
    }


def build_feedback_rule(
    item: Item,
    correct: bool,
    hints_used: int,
    misconception_codes: List[str],
    misconception_names: Dict[str, str],
    bundle: ContentBundle,
    cfg: CoachConfig,
    seed: int = 0,
) -> Dict[str, object]:
    """按"对/错 × 是否用提示"给出反馈文案与语气。"""
    if correct and hints_used == 0:
        key = "correct_without_hint"
    elif correct:
        key = "correct_with_hint"
    elif misconception_codes:
        key = "incorrect_with_misconception"
    else:
        key = "incorrect"

    tone = cfg.feedback_tone(key, default="encourage" if correct else "repair")
    opener = _pick(cfg.openers(tone), seed)

    texts = cfg.feedback_texts(key)
    template = _pick(texts, seed) if texts else "{opener}。"

    misconception_hint = ""
    if misconception_codes:
        first = misconception_codes[0]
        name = misconception_names.get(first, "")
        prompt = cfg.concept_prompt(item.competency_id)
        # 只描述该能力范围内的动作，不点破具体答案
        misconception_hint = prompt or "我们回头看看题目问的是什么。"
        if name and not prompt:
            misconception_hint = "这个坑叫「{}」，我们换个办法绕过去。".format(name)

    text = template.format(opener=opener, misconception_hint=misconception_hint)
    return {
        "tone": tone,
        "text": text,
        "character": "小助手",
        "misconception_hint": misconception_hint,
    }
