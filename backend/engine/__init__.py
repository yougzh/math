"""学习引擎。

模块划分（对应学习决策链）：

    graph.py          Competency 能力图谱
    intent.py         Child State → Learning Intent     ← 系统的"大脑"第一层
    planner.py        Intent → Daily Plan
    selector.py       Challenge Slot → Item             ← 具体做哪一道
    proficiency.py    5 个原始信号 + EWMA（纯函数）
    state_machine.py  等级派生 / 升级判定 / 回退判定
    diagnosis.py      错误认知归因
    learner.py        状态推进器（在线与 replay 共用）
    replay.py         历史重放
    types.py          领域类型
"""
