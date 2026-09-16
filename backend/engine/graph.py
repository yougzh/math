"""能力图谱。

Competency 是知识骨架，Problem Pattern 挂在能力上。
Planner 依据这张图决定"下一步练什么"和"回退到哪里"。
"""
from __future__ import annotations

from typing import Dict, List, Optional, Set

from backend.content.loader import Competency, ContentBundle, Pattern


class CompetencyGraph:
    def __init__(self, bundle: ContentBundle):
        self.competencies: Dict[str, Competency] = dict(bundle.competencies)
        self.patterns: Dict[str, Pattern] = dict(bundle.patterns)
        self._topo: Optional[List[str]] = None

    # ── 边 ──────────────────────────────────────────────
    def prerequisites(self, code: str, transitive: bool = False) -> List[str]:
        comp = self.competencies.get(code)
        if comp is None:
            return []
        if not transitive:
            return list(comp.prerequisites)
        seen: Set[str] = set()
        stack = list(comp.prerequisites)
        while stack:
            current = stack.pop()
            if current in seen:
                continue
            seen.add(current)
            parent = self.competencies.get(current)
            if parent:
                stack.extend(parent.prerequisites)
        return sorted(seen)

    def dependents(self, code: str) -> List[str]:
        return sorted(
            c.code for c in self.competencies.values() if code in c.prerequisites
        )

    # ── 拓扑 ────────────────────────────────────────────
    def topological_order(self) -> List[str]:
        """确定性顺序：按 (stage, code) 稳定排序后做 DFS，保证 replay 可重现。"""
        if self._topo is not None:
            return list(self._topo)

        order: List[str] = []
        visited: Dict[str, int] = {}  # 0=未访问 1=访问中 2=已完成

        def visit(code: str):
            state = visited.get(code, 0)
            if state == 2:
                return
            if state == 1:
                return  # 有环时由 validate() 报错，这里只保证不死循环
            visited[code] = 1
            comp = self.competencies.get(code)
            if comp:
                for prereq in sorted(comp.prerequisites):
                    visit(prereq)
            visited[code] = 2
            order.append(code)

        for code in sorted(
            self.competencies.keys(),
            key=lambda c: (self.competencies[c].stage, c),
        ):
            visit(code)

        self._topo = order
        return list(order)

    # ── Pattern 关联 ────────────────────────────────────
    def patterns_for(self, competency_code: str) -> List[Pattern]:
        return sorted(
            (p for p in self.patterns.values() if p.applies_to(competency_code)),
            key=lambda p: (p.cognitive_type, p.code),
        )

    # ── 校验 ────────────────────────────────────────────
    def find_cycles(self) -> List[List[str]]:
        cycles: List[List[str]] = []
        color: Dict[str, int] = {}
        stack: List[str] = []

        def dfs(code: str):
            color[code] = 1
            stack.append(code)
            comp = self.competencies.get(code)
            for prereq in sorted(comp.prerequisites) if comp else []:
                if prereq not in self.competencies:
                    continue
                c = color.get(prereq, 0)
                if c == 1:
                    cycles.append(stack[stack.index(prereq):] + [prereq])
                elif c == 0:
                    dfs(prereq)
            stack.pop()
            color[code] = 2

        for code in sorted(self.competencies.keys()):
            if color.get(code, 0) == 0:
                dfs(code)
        return cycles

    def validate(self) -> List[str]:
        problems: List[str] = []

        for cycle in self.find_cycles():
            problems.append("能力图存在环: {}".format(" → ".join(cycle)))

        for comp in self.competencies.values():
            for prereq in comp.prerequisites:
                if prereq == comp.code:
                    problems.append("competency {} 依赖自己".format(comp.code))
            if not self.patterns_for(comp.code):
                problems.append(
                    "competency {} 没有任何可用 pattern（该能力无法被训练）".format(comp.code)
                )
            if not comp.prerequisites and not self.dependents(comp.code):
                problems.append(
                    "competency {} 是孤立节点（既无前置也无人依赖）".format(comp.code)
                )

        return problems

    # ── 查询辅助 ────────────────────────────────────────
    def next_unmastered(self, is_mastered) -> Optional[str]:
        """按拓扑顺序返回第一个"前置都已掌握、但自身未掌握"的能力。"""
        for code in self.topological_order():
            if is_mastered(code):
                continue
            if all(is_mastered(p) for p in self.prerequisites(code)):
                return code
        return None

    def weakest_prerequisite(self, code: str, score):
        """在（传递）前置能力里找得分最低的一个，作为回退目标。"""
        prereqs = self.prerequisites(code, transitive=True)
        if not prereqs:
            return None
        return min(prereqs, key=lambda p: (score(p), p))
