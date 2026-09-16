"""P2 数据持久层测试。

覆盖：schema 与 SQL 的一致性、内容导入幂等、attempt 单事务与回滚、
幂等键、后端判定权威、熟练度持久化与等级派生（ADR-0002）、
以及"答案永不下发"的不变量。

测试库策略：session 级建一个"模板库"（create_all + init_db 导入真实内容），
function 级复制成临时文件 —— 每个用例一个干净库，互不干扰。
"""
from __future__ import annotations

import os
import re
import shutil
from typing import Any, Dict, List
from uuid import uuid4

import pytest

from backend.coach.service import default_service
from backend.db import models
from backend.db.base import Base
from backend.db.session import create_db_engine, create_session_factory
from backend.engine.config import AlgorithmConfig
from backend.engine.replay import replay, states_equal
from backend.engine.state_machine import derive_level
from backend.engine.types import Telemetry
from backend.paths import ROOT
from backend.service.content import ContentService, item_payload
from backend.service.learning import (
    AttemptSubmission,
    load_attempts,
    load_state,
    submit_attempt,
)
from tools import init_db

MIGRATION_PATH = os.path.join(ROOT, "db", "migrations", "0001_init.sql")


# ═══════════════════════════════════════════════════════════
# Fixtures（test_api.py 会 import 这里的 db_path）
# ═══════════════════════════════════════════════════════════
@pytest.fixture(scope="session")
def db_template(tmp_path_factory) -> str:
    """模板库：把当前内容（YAML）导出并导入一次，后续用例复制使用。

    导出到临时目录而不是 build/，保证测试永远对着**当前**内容跑，
    也不会覆盖开发者的构建产物。
    """
    from tools.content_cli import main as content_cli

    workdir = tmp_path_factory.mktemp("db-template")
    dump_path = str(workdir / "content_dump.json")
    assert content_cli.main(["dump", "--out", dump_path]) == 0
    path = str(workdir / "template.db")
    assert init_db.main(["--db-url", "sqlite:///" + path, "--dump", dump_path]) == 0
    return path


@pytest.fixture
def db_path(db_template, tmp_path) -> str:
    target = tmp_path / "test.db"
    shutil.copy(db_template, str(target))
    return str(target)


@pytest.fixture
def session(db_path):
    engine = create_db_engine("sqlite:///" + db_path)
    factory = create_session_factory(engine)
    handle = factory()
    try:
        yield handle
    finally:
        handle.close()


@pytest.fixture
def coach(bundle, graph):
    return default_service(bundle, graph)


@pytest.fixture
def make_ten_item(bundle):
    items = [i for i in bundle.items.values() if i.competency_id == "make_ten"]
    assert items, "内容里必须有 make_ten 的题"
    return items[0]


def submit(
    session,
    bundle,
    cfg,
    coach,
    item,
    correct: bool = True,
    client_attempt_id: str = None,
    hints_used: int = 0,
    thinking_ms: int = 2000,
    active_ms: int = 1000,
    child_id: int = 1,
    slot_code: str = None,
    session_id: int = None,
    client_correct: bool = None,
    is_assessment: bool = False,
) -> Dict[str, Any]:
    if correct:
        answer = item.answer
    else:
        answer = item.answer + 1 if isinstance(item.answer, int) else "___"
    submission = AttemptSubmission(
        client_attempt_id=client_attempt_id or str(uuid4()),
        child_id=child_id,
        item_code=item.code,
        answer=answer,
        telemetry=Telemetry(
            response_time_ms=thinking_ms + active_ms, active_time_ms=active_ms
        ),
        session_id=session_id,
        slot_code=slot_code,
        client_correct=client_correct,
        hints_used=hints_used,
        hint_level_max=hints_used,
        is_assessment=is_assessment,
    )
    return submit_attempt(session, bundle, cfg, coach, submission)


# ═══════════════════════════════════════════════════════════
# schema 一致性
# ═══════════════════════════════════════════════════════════
def _strip_sql_comments(text: str) -> str:
    return "\n".join(line.split("--")[0] for line in text.splitlines())


def _split_top_level(body: str) -> List[str]:
    parts: List[str] = []
    depth = 0
    current: List[str] = []
    for char in body:
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        if char == "," and depth == 0:
            parts.append("".join(current))
            current = []
        else:
            current.append(char)
    if current:
        parts.append("".join(current))
    return parts


def parse_migration(sql_text: str) -> Dict[str, List[str]]:
    """解析 0001_init.sql 里的 CREATE TABLE，返回 {表名: [列名]}。"""
    text = _strip_sql_comments(sql_text)
    tables: Dict[str, List[str]] = {}
    cursor = 0
    pattern = re.compile(r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_]+)\s*\(", re.I)
    while True:
        match = pattern.search(text, cursor)
        if match is None:
            break
        name = match.group(1)
        start = match.end()
        depth = 1
        index = start
        while index < len(text) and depth > 0:
            if text[index] == "(":
                depth += 1
            elif text[index] == ")":
                depth -= 1
            index += 1
        body = text[start : index - 1]
        cursor = index

        columns = []
        for part in _split_top_level(body):
            head = part.strip().split()[0] if part.strip() else ""
            if not head:
                continue
            if head.upper() in (
                "PRIMARY",
                "UNIQUE",
                "CHECK",
                "FOREIGN",
                "CONSTRAINT",
                "EXCLUDE",
            ):
                continue
            columns.append(head)
        tables[name] = columns
    return tables


def test_schema_matches_migration():
    """ORM 必须与 db/migrations/0001_init.sql 的表名 / 列名集合完全一致。

    这份 SQL 是部署事实。如果不一致，说明要么 ORM 写错，要么 SQL 需要一次
    正式的迁移评审（见 P2 报告）。
    """
    with open(MIGRATION_PATH, "r", encoding="utf-8") as handle:
        sql_tables = parse_migration(handle.read())

    orm_tables = {name: [column.name for column in table.columns] for name, table in Base.metadata.tables.items()}

    assert set(sql_tables) == set(orm_tables), "表名集合不一致：SQL={} ORM={}".format(
        sorted(set(sql_tables) - set(orm_tables)),
        sorted(set(orm_tables) - set(sql_tables)),
    )
    for name in sorted(sql_tables):
        missing_in_orm = set(sql_tables[name]) - set(orm_tables[name])
        missing_in_sql = set(orm_tables[name]) - set(sql_tables[name])
        assert not missing_in_orm, "{}: ORM 缺少列 {}".format(name, sorted(missing_in_orm))
        assert not missing_in_sql, "{}: ORM 多了列 {}".format(name, sorted(missing_in_sql))


def test_migration_has_no_level_column_in_state_tables():
    """ADR-0002 的 schema 侧证据：状态表里不允许出现 level 列。"""
    with open(MIGRATION_PATH, "r", encoding="utf-8") as handle:
        sql_tables = parse_migration(handle.read())
    assert "level" not in sql_tables["proficiency_state"]
    assert "level" not in sql_tables["pattern_state"]
    assert "level" not in [column.name for column in models.ProficiencyState.__table__.columns]


# ═══════════════════════════════════════════════════════════
# 内容导入
# ═══════════════════════════════════════════════════════════
def test_init_db_is_idempotent(db_path):
    url = "sqlite:///" + db_path
    assert init_db.main(["--db-url", url]) == 0
    engine = create_db_engine(url)
    factory = create_session_factory(engine)
    handle = factory()
    before = {
        "item": handle.query(models.Item).count(),
        "competency": handle.query(models.Competency).count(),
        "slot": handle.query(models.ChallengeSlot).count(),
        "release": handle.query(models.ContentRelease).count(),
        "child": handle.query(models.Child).count(),
    }
    handle.close()

    assert init_db.main(["--db-url", url]) == 0
    handle = factory()
    after = {
        "item": handle.query(models.Item).count(),
        "competency": handle.query(models.Competency).count(),
        "slot": handle.query(models.ChallengeSlot).count(),
        "release": handle.query(models.ContentRelease).count(),
        "child": handle.query(models.Child).count(),
    }
    handle.close()
    assert before == after
    assert before["item"] > 0 and before["release"] == 1 and before["child"] == 1


def test_algorithm_config_versions_are_pinned(session):
    """ADR-0002：状态必须 pin 算法版本，所以 algorithm_config 必须先存在。"""
    row = session.query(models.AlgorithmConfig).filter_by(version=0).one()
    assert row.payload_json["version"] == 0
    assert isinstance(row.payload_json["level_thresholds"], dict)


# ═══════════════════════════════════════════════════════════
# attempt 单事务（ADR-0004）
# ═══════════════════════════════════════════════════════════
def test_attempt_writes_everything_in_one_transaction(
    session, bundle, cfg, coach, make_ten_item
):
    response = submit(session, bundle, cfg, coach, make_ten_item, correct=True)
    assert response["duplicate"] is False
    assert response["correct"] is True
    assert response["attempt_id"] is not None
    assert response["seq"] == 1

    attempt = session.query(models.Attempt).one()
    assert attempt.correct is True
    assert attempt.judgement_mismatch is False
    # 脚手架 / 交互类型是 attempt 表的列（0001 修订），不再塞 submitted_json 快照
    assert attempt.scaffold_level == make_ten_item.scaffold_level
    assert attempt.interaction_type == make_ten_item.interaction_type

    assert session.query(models.LearningEvent).count() == 1
    assert session.query(models.RewardLog).count() == 1
    assert session.query(models.Inventory).count() >= 1
    assert session.query(models.ProficiencyState).count() == 1
    assert session.query(models.PatternState).count() == 1
    assert session.query(models.ReviewSchedule).count() == 1

    state = session.query(models.ProficiencyState).one()
    assert state.sample_count == 1
    assert state.algorithm_version == cfg.version
    assert state.mastery is not None


def test_attempt_rolls_back_completely_on_error(
    session, bundle, cfg, coach, make_ten_item, monkeypatch
):
    """事务中途抛错 → attempt / event / reward / 状态全部回滚。"""
    import backend.service.learning as learning_service

    def boom(*args, **kwargs):
        raise RuntimeError("注入的失败（测试事务原子性）")

    monkeypatch.setattr(learning_service, "record_reward", boom)

    with pytest.raises(RuntimeError):
        submit(session, bundle, cfg, coach, make_ten_item, correct=True)

    assert session.query(models.Attempt).count() == 0
    assert session.query(models.LearningEvent).count() == 0
    assert session.query(models.RewardLog).count() == 0
    assert session.query(models.ProficiencyState).count() == 0
    assert session.query(models.PatternState).count() == 0
    assert session.query(models.ReviewSchedule).count() == 0


def test_session_counter_shares_the_transaction(
    session, bundle, cfg, coach, make_ten_item
):
    learning_session = models.LearningSession(child_id=1, planned_minutes=12)
    session.add(learning_session)
    session.commit()

    submit(
        session,
        bundle,
        cfg,
        coach,
        make_ten_item,
        correct=True,
        slot_code="core_make_ten_practice",
        session_id=learning_session.id,
    )
    session.refresh(learning_session)
    assert learning_session.item_count == 1


# ═══════════════════════════════════════════════════════════
# 幂等
# ═══════════════════════════════════════════════════════════
def test_same_client_attempt_id_writes_once(session, bundle, cfg, coach, make_ten_item):
    key = str(uuid4())
    first = submit(
        session, bundle, cfg, coach, make_ten_item, correct=True, client_attempt_id=key
    )
    second = submit(
        session, bundle, cfg, coach, make_ten_item, correct=True, client_attempt_id=key
    )

    assert session.query(models.Attempt).count() == 1
    assert second["duplicate"] is True
    assert second["attempt_id"] == first["attempt_id"]
    assert second["seq"] == first["seq"]
    assert second["progress"] == first["progress"]
    assert second["reward"] == first["reward"]
    assert second["feedback"] == first["feedback"]

    state = session.query(models.ProficiencyState).one()
    assert state.sample_count == 1, "重复提交不得再推进一次状态"


def test_different_keys_write_two_attempts(session, bundle, cfg, coach, make_ten_item):
    submit(session, bundle, cfg, coach, make_ten_item, correct=True)
    submit(session, bundle, cfg, coach, make_ten_item, correct=True)
    assert session.query(models.Attempt).count() == 2
    state = session.query(models.ProficiencyState).one()
    assert state.sample_count == 2


# ═══════════════════════════════════════════════════════════
# 判定权威（ADR-0004 双轨判定）
# ═══════════════════════════════════════════════════════════
def test_backend_judgement_wins_over_client(session, bundle, cfg, coach, make_ten_item):
    response = submit(
        session,
        bundle,
        cfg,
        coach,
        make_ten_item,
        correct=False,           # 真实提交一个错答案
        client_correct=True,     # 前端却说自己算对了
    )
    assert response["correct"] is False
    assert response["judgement_mismatch"] is True

    attempt = session.query(models.Attempt).one()
    assert attempt.correct is False
    assert attempt.judgement_mismatch is True


def test_client_correct_matching_backend_is_not_mismatch(
    session, bundle, cfg, coach, make_ten_item
):
    response = submit(
        session, bundle, cfg, coach, make_ten_item, correct=True, client_correct=True
    )
    assert response["correct"] is True
    assert response["judgement_mismatch"] is False


# ═══════════════════════════════════════════════════════════
# 熟练度上升 / 持久化 / 派生等级
# ═══════════════════════════════════════════════════════════
def test_proficiency_state_rises_with_correct_attempts(
    session, bundle, cfg, coach, make_ten_item
):
    before = load_state(session, 1, bundle, cfg)
    assert before.competencies.get("make_ten") is None

    for _ in range(8):
        submit(session, bundle, cfg, coach, make_ten_item, correct=True, hints_used=0)

    row = (
        session.query(models.ProficiencyState)
        .filter_by(child_id=1, competency_code="make_ten")
        .one()
    )
    assert row.sample_count == 8
    assert row.mastery == pytest.approx(1.0, abs=1e-6)
    assert row.accuracy == pytest.approx(1.0, abs=1e-6)
    assert row.independence == pytest.approx(1.0, abs=1e-6)

    signals = load_state(session, 1, bundle, cfg).competencies["make_ten"]
    assert derive_level(signals, cfg) != cfg.level_order[0]


def test_state_is_persisted_not_kept_in_memory(session, bundle, cfg, coach, make_ten_item):
    """写库后重新查出来构造 state，结果与内存里逐轮推进的 state 一致。"""
    from backend.engine.learner import apply_attempt, new_state
    from backend.service.learning import attempt_from_row

    expected = new_state("1")
    for _ in range(3):
        response = submit(session, bundle, cfg, coach, make_ten_item, correct=True)
        attempt = (
            session.query(models.Attempt)
            .filter_by(id=response["attempt_id"])
            .one()
        )
        expected = apply_attempt(expected, attempt_from_row(attempt, bundle), bundle, cfg)

    reloaded = load_state(session, 1, bundle, cfg)
    assert states_equal(reloaded, expected)

    # 再与引擎的 replay 对齐（在线更新与 replay 必须同一段代码）
    rows = load_attempts(session, 1)
    replayed = replay(
        "1", [attempt_from_row(r, bundle) for r in rows], bundle, cfg, graph=None
    ).final_state
    assert states_equal(reloaded, replayed)


def test_pattern_state_key_carries_competency(session, bundle, cfg, coach, make_ten_item):
    submit(session, bundle, cfg, coach, make_ten_item, correct=True)
    row = session.query(models.PatternState).one()
    assert row.competency_code == make_ten_item.competency_id
    assert row.pattern_code == make_ten_item.pattern_id
    assert row.sample_count == 1


# ═══════════════════════════════════════════════════════════
# 复习调度（engine.scheduler 接管，P3）
# ═══════════════════════════════════════════════════════════
def test_review_schedule_matches_engine_scheduler(
    session, bundle, cfg, coach, make_ten_item
):
    """review_schedule 是调度器重放结果的投影，键与 scheduler.py 对齐。

    - target_type='pattern'，target_code=pattern_key（"{competency}::{pattern}"）
    - 连续答对 → 间隔档位前进；答错 → 退回第 1 档
    - probe（is_assessment）不推进调度
    """
    submit(session, bundle, cfg, coach, make_ten_item, correct=True)
    submit(session, bundle, cfg, coach, make_ten_item, correct=True)

    pattern_key = "{}::{}".format(make_ten_item.competency_id, make_ten_item.pattern_id)
    row = (
        session.query(models.ReviewSchedule)
        .filter_by(child_id=1, target_type="pattern", target_code=pattern_key)
        .one()
    )
    intervals = cfg.review_intervals_days
    assert row.stage_index == 1, "连续答对 2 次 → 第 2 档间隔"
    assert row.interval_days == intervals[1]

    submit(session, bundle, cfg, coach, make_ten_item, correct=False)
    row = (
        session.query(models.ReviewSchedule)
        .filter_by(child_id=1, target_type="pattern", target_code=pattern_key)
        .one()
    )
    assert session.query(models.ReviewSchedule).count() == 1
    assert row.stage_index == 0, "答错退回第 1 档"
    assert row.interval_days == intervals[0]

    # probe 不推进：提交 is_assessment 后调度不变
    submit(
        session,
        bundle,
        cfg,
        coach,
        make_ten_item,
        correct=True,
        is_assessment=True,
    )
    row = (
        session.query(models.ReviewSchedule)
        .filter_by(child_id=1, target_type="pattern", target_code=pattern_key)
        .one()
    )
    assert row.stage_index == 0, "探测题不参与复习调度"


# ═══════════════════════════════════════════════════════════
# ADR-0002：等级是派生值
# ═══════════════════════════════════════════════════════════
def _thresholds_raised_config(cfg: AlgorithmConfig) -> AlgorithmConfig:
    """复制 v0 配置，把 understanding / can_do 的门槛提到现有证据达不到的高度。

    模拟"新算法收紧了判定标准"——用来证明同一批历史数据在不同配置下
    会派生出不同等级（ADR-0002 的场景）。
    """
    import copy

    import yaml

    from backend.paths import ALGORITHM_CONFIG_DIR

    with open(
        os.path.join(ALGORITHM_CONFIG_DIR, "v0.yaml"), "r", encoding="utf-8"
    ) as handle:
        raw = yaml.safe_load(handle)
    raw = copy.deepcopy(raw)
    raw["level_thresholds"]["understanding"] = {"mastery": 1.5, "accuracy": 1.5}
    raw["level_thresholds"]["can_do"] = {"mastery": 1.5}
    return AlgorithmConfig(raw)


def test_level_is_derived_and_changes_with_config(
    session, bundle, cfg, coach, make_ten_item
):
    """同一批数据，只换算法阈值 → 等级变化。这证明 level 没有被存进数据库。"""
    for _ in range(8):
        submit(session, bundle, cfg, coach, make_ten_item, correct=True)

    signals = load_state(session, 1, bundle, cfg).competencies["make_ten"]
    level_v0 = derive_level(signals, cfg)

    stricter = _thresholds_raised_config(cfg)
    level_strict = derive_level(signals, stricter)

    assert level_v0 in ("understanding", "can_do", "proficient", "automatic")
    assert level_strict != level_v0
    assert cfg.level_order.index(level_strict) < cfg.level_order.index(level_v0)

    # 库里只有信号，没有 level 字段（列名都没有）
    columns = {column.name for column in models.ProficiencyState.__table__.columns}
    assert "level" not in columns


# ═══════════════════════════════════════════════════════════
# 答案不下发
# ═══════════════════════════════════════════════════════════
def _assert_no_answer_keys(payload: Any, path: str = "$"):
    if isinstance(payload, dict):
        for key, value in payload.items():
            assert key not in ("answer", "steps"), "{} 泄漏了字段 {}".format(path, key)
            _assert_no_answer_keys(value, "{}.{}".format(path, key))
    elif isinstance(payload, list):
        for index, value in enumerate(payload):
            _assert_no_answer_keys(value, "{}[{}]".format(path, index))


def test_item_payload_never_leaks_answer(bundle):
    payload = item_payload(bundle.items[list(bundle.items)[0]])
    _assert_no_answer_keys(payload)
    assert "answer" not in payload and "steps" not in payload
    assert payload["hints_available"] == len(
        bundle.items[list(bundle.items)[0]].hint_chain
    )


# ═══════════════════════════════════════════════════════════
# 内容读取路径：DB 优先
# ═══════════════════════════════════════════════════════════
def test_content_bundle_is_rebuilt_from_db(session, bundle):
    service = ContentService()
    from_db = service.bundle(session)
    assert set(from_db.items) == set(bundle.items)
    assert set(from_db.competencies) == set(bundle.competencies)
    assert set(from_db.slots) == set(bundle.slots)
    sample = sorted(bundle.items)[0]
    assert from_db.items[sample].answer == bundle.items[sample].answer
    assert from_db.items[sample].hint_chain == bundle.items[sample].hint_chain
    # 故事也要能从库里重建
    assert set(from_db.stories) == set(bundle.stories)
    assert sum(len(s.beats) for s in from_db.stories.values()) == sum(
        len(s.beats) for s in bundle.stories.values()
    )


def test_content_service_falls_back_to_memory_when_db_empty(tmp_path, bundle):
    from backend.db.base import Base as Tables
    from backend.db.session import (
        create_db_engine as make_engine,
        create_session_factory as make_factory,
    )

    url = "sqlite:///" + str(tmp_path / "empty.db")
    engine = make_engine(url)
    Tables.metadata.create_all(engine)
    handle = make_factory(engine)()
    try:
        service = ContentService(memory_bundle=bundle)
        loaded = service.bundle(handle)
        assert set(loaded.items) == set(bundle.items)
    finally:
        handle.close()
