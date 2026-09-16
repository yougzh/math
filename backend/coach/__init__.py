"""AI 教练。

分工：
    rules.py      说什么（受教学法约束）
    llm.py        怎么写才自然（可离线，返回 None 就退回规则文案）
    validators.py 四道护栏（一票否决）
    service.py    编排 + 兜底

不变量：未经护栏的文本永远不出现在孩子眼前。
"""
from backend.coach.service import CoachMessage, CoachService, default_service  # noqa: F401
