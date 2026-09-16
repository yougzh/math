"""教练编排：规则先说话，LLM 只能改写，护栏一票否决。

    rule_text ──► LLM.rewrite ──► 四道护栏 ──► 通过？用 LLM 文案
                                        └── 不通过？用 rule_text

关键不变量：**任何未经护栏的文本都不会出现在返回值里**。
被拦下的文本与原因会记在 `rejected` 里，方便复盘模型到底想说什么。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from backend.coach import rules, validators
from backend.coach.config import CoachConfig, load_coach_config
from backend.coach.llm import LLMAdapter, NullLLM
from backend.content.loader import ContentBundle, Item

REWRITE_INSTRUCTION = (
    "把下面这句小学数学教练的话改写得更自然、更像对一个 8 岁孩子说的，"
    "不要改变它给出的方法，不要说出答案，不要提到还没学的内容，"
    "不要超过 40 个字，只输出改写后的一句话。"
)


@dataclass
class CoachMessage:
    tone: str
    text: str
    character: str = "小助手"
    source: str = "rule"           # rule | llm | fallback
    level: int = 0
    exhausted: bool = False
    rejected: List[str] = field(default_factory=list)   # 被护栏拦下的尝试

    def to_dict(self) -> Dict[str, Any]:
        """反馈形状：用在做题后的 feedback 字段（见 api-contract §4）。"""
        return {"tone": self.tone, "text": self.text, "character": self.character}

    def to_hint_dict(self) -> Dict[str, Any]:
        """提示形状：用在 `POST /v1/coach/hints` 的响应（见 api-contract §6）。"""
        return {
            "hint_level": self.level,
            "hint_text": self.text,
            "source": self.source,
            "fallback_used": self.source == "fallback",
            "exhausted": self.exhausted,
        }


class CoachService:
    def __init__(
        self,
        bundle: ContentBundle,
        graph,
        cfg: Optional[CoachConfig] = None,
        llm: Optional[LLMAdapter] = None,
        allow_llm: bool = True,
    ):
        self.bundle = bundle
        self.graph = graph
        self.cfg = cfg or load_coach_config(0)
        self.llm = llm or NullLLM()
        self.allow_llm = allow_llm

    # ── 提示 ─────────────────────────────────────────────
    def hint(
        self,
        item: Item,
        hints_used: int,
        misconception_code: Optional[str] = None,
    ) -> CoachMessage:
        rule = rules.build_hint_rule_text(item, hints_used, self.cfg, misconception_code)
        return self._maybe_rewrite(
            rule,
            item,
            seed=hints_used,
            character="小助手",
        )

    # ── 反馈 ─────────────────────────────────────────────
    def feedback(
        self,
        item: Item,
        correct: bool,
        hints_used: int,
        misconception_codes: Optional[List[str]] = None,
        seed: int = 0,
    ) -> CoachMessage:
        misconception_codes = misconception_codes or []
        names = {
            code: self.bundle.misconceptions[code].name
            for code in misconception_codes
            if code in self.bundle.misconceptions
        }
        rule = rules.build_feedback_rule(
            item=item,
            correct=correct,
            hints_used=hints_used,
            misconception_codes=misconception_codes,
            misconception_names=names,
            bundle=self.bundle,
            cfg=self.cfg,
            seed=seed,
        )
        return self._maybe_rewrite(rule, item, seed=seed, character="小助手")

    # ── 护栏通道 ─────────────────────────────────────────
    def _maybe_rewrite(self, rule: Dict[str, Any], item: Item, seed: int, character: str) -> CoachMessage:
        rule_text = str(rule.get("text", ""))
        message = CoachMessage(
            tone=str(rule.get("tone", "encourage")),
            text=rule_text,
            character=str(rule.get("character", character)),
            source="rule",
            level=int(rule.get("level", 0)),
            exhausted=bool(rule.get("exhausted", False)),
        )

        # 规则文案本身也必须过护栏：规则写错了同样会伤到孩子
        own_problems = validators.run_all(rule_text, item, self.graph, self.cfg)
        if own_problems:
            message.rejected.extend(
                ["规则文案未过护栏：{}".format(p) for p in own_problems]
            )
            message.text = _safe_fallback(item, self.cfg)
            message.source = "fallback"
            return message

        if not (self.allow_llm and self.llm.available()):
            return message

        candidate = self.llm.rewrite(
            REWRITE_INSTRUCTION,
            rule_text,
            {
                "competency": item.competency_id,
                "pattern": item.pattern_id,
                "difficulty": item.difficulty,
                "tone": message.tone,
            },
        )
        if not candidate:
            return message

        problems = validators.run_all(candidate, item, self.graph, self.cfg)
        if problems:
            message.rejected.extend(problems)
            return message

        message.text = candidate
        message.source = "llm"
        return message


def _safe_fallback(item: Item, cfg: CoachConfig) -> str:
    """兜底文案：永远安全，永远有内容。"""
    prompt = cfg.concept_prompt(item.competency_id)
    return prompt or "我们一步一步来。"


def default_service(bundle: ContentBundle, graph, llm: Optional[LLMAdapter] = None) -> CoachService:
    return CoachService(bundle, graph, load_coach_config(0), llm)
