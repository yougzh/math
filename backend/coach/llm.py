"""LLM 适配层。

默认**离线**：没有配置模型时返回 None，教练自动退回规则文案。
这样开发、测试、断网、额度用尽都不会让孩子看到一个坏掉的界面。

接入真模型时只实现 `rewrite()` 一个方法即可 —— 注意它返回的文案
仍然要过四道护栏（见 service.py）。
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional


class LLMAdapter:
    """改写一句话，不改事实。"""

    name = "base"

    def available(self) -> bool:
        return False

    def rewrite(self, instruction: str, rule_text: str, context: Dict[str, Any]) -> Optional[str]:
        raise NotImplementedError


class NullLLM(LLMAdapter):
    """离线：什么都不做，让调用方退回规则文案。"""

    name = "null"

    def available(self) -> bool:
        return False

    def rewrite(self, instruction, rule_text, context):  # pragma: no cover - 永远返回 None
        return None


class HTTPLLM(LLMAdapter):
    """最薄的一层 HTTP 适配。

    不绑定任何厂商 SDK：一个 POST，一个 JSON 里的 text 字段。
    用环境变量开启：

        MATH_COACH_LLM_URL=https://.../v1/chat
        MATH_COACH_LLM_KEY=...
        MATH_COACH_LLM_MODEL=...
    """

    name = "http"

    def __init__(self, url: str, key: str = "", model: str = "", timeout: float = 6.0):
        self.url = url
        self.key = key
        self.model = model
        self.timeout = timeout

    def available(self) -> bool:
        return bool(self.url)

    def rewrite(self, instruction, rule_text, context):
        payload = {
            "model": self.model,
            "instruction": instruction,
            "text": rule_text,
            "context": context,
        }
        request = urllib.request.Request(
            self.url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                **({"Authorization": "Bearer {}".format(self.key)} if self.key else {}),
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                data = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, OSError, ValueError):
            return None
        text = data.get("text") if isinstance(data, dict) else None
        return str(text) if text else None


def default_adapter() -> LLMAdapter:
    url = os.environ.get("MATH_COACH_LLM_URL", "").strip()
    if not url:
        return NullLLM()
    return HTTPLLM(
        url=url,
        key=os.environ.get("MATH_COACH_LLM_KEY", "").strip(),
        model=os.environ.get("MATH_COACH_LLM_MODEL", "").strip(),
    )
