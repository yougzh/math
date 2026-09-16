-- 数学世界 · 初始化 schema
-- 目标数据库：PostgreSQL 13+
--
-- 设计依据（改动前先读 ADR）：
--   ADR-0001  故事通过 challenge_slot 与题目解耦
--   ADR-0002  等级是派生值，不落库为权威
--   ADR-0003  时间语义冻结：response / active / idle，thinking 由计算得出
--   ADR-0004  attempt 是学习系统唯一事实入口

BEGIN;

-- ═══════════════════════════════════════════════════════════
-- 学习域：能力图谱与内容
-- ═══════════════════════════════════════════════════════════

CREATE TABLE competency (
    code        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    stage       INTEGER NOT NULL DEFAULT 1,
    active      BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE competency_prerequisite (
    competency_code   TEXT NOT NULL REFERENCES competency(code) ON DELETE CASCADE,
    prerequisite_code TEXT NOT NULL REFERENCES competency(code) ON DELETE CASCADE,
    weight            NUMERIC(4,3) NOT NULL DEFAULT 1.0,
    PRIMARY KEY (competency_code, prerequisite_code),
    CHECK (competency_code <> prerequisite_code)
);

CREATE TABLE problem_pattern (
    code           TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    -- 只允许 compute / represent / strategy / apply / reverse
    cognitive_type TEXT NOT NULL,
    CHECK (cognitive_type IN ('compute', 'represent', 'strategy', 'apply', 'reverse'))
);

-- pattern 可以用于多个能力；decompose 用在 make_ten 和用在 td_add_nocarry 上不是同一个技能
CREATE TABLE pattern_competency (
    pattern_code    TEXT NOT NULL REFERENCES problem_pattern(code) ON DELETE CASCADE,
    competency_code TEXT NOT NULL REFERENCES competency(code) ON DELETE CASCADE,
    is_primary      BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (pattern_code, competency_code)
);

CREATE TABLE misconception (
    code                   TEXT PRIMARY KEY,
    name                   TEXT NOT NULL,
    description            TEXT NOT NULL DEFAULT '',
    severity               SMALLINT NOT NULL DEFAULT 1,
    remediation_competency TEXT REFERENCES competency(code)
);

CREATE TABLE item (
    code               TEXT PRIMARY KEY,
    competency_code    TEXT NOT NULL REFERENCES competency(code),
    pattern_code       TEXT NOT NULL REFERENCES problem_pattern(code),
    difficulty         SMALLINT NOT NULL DEFAULT 1,
    scaffold_level     TEXT NOT NULL
                       CHECK (scaffold_level IN ('blocks', 'decompose', 'direct')),
    interaction_type   TEXT NOT NULL,
    estimated_seconds  INTEGER NOT NULL DEFAULT 15 CHECK (estimated_seconds > 0),
    problem_json       JSONB NOT NULL,
    answer_json        JSONB NOT NULL,
    steps_json         JSONB NOT NULL DEFAULT '[]'::jsonb,
    hint_chain_json    JSONB NOT NULL DEFAULT '[]'::jsonb,
    error_rules_json   JSONB NOT NULL DEFAULT '[]'::jsonb,
    source_template    TEXT,
    review_status      TEXT NOT NULL DEFAULT 'draft'
                       CHECK (review_status IN ('draft', 'approved', 'retired')),
    content_release_id BIGINT
);

CREATE INDEX item_lookup_idx ON item (competency_code, pattern_code, scaffold_level, difficulty);

-- ═══════════════════════════════════════════════════════════
-- 内容版本 / 算法配置
-- ═══════════════════════════════════════════════════════════

CREATE TABLE content_release (
    id          BIGSERIAL PRIMARY KEY,
    version     TEXT NOT NULL UNIQUE,
    checksum    TEXT NOT NULL,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    stats_json  JSONB NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE item
    ADD CONSTRAINT item_release_fk
    FOREIGN KEY (content_release_id) REFERENCES content_release(id);

-- 状态必须 pin 住自己是用哪个版本的算法算出来的（ADR-0002 可回放的前提）
CREATE TABLE algorithm_config (
    version      INTEGER PRIMARY KEY,
    payload_json JSONB NOT NULL,
    is_active    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════
-- 账号（MVP 极简：不做社交、不做复杂账号体系）
-- ═══════════════════════════════════════════════════════════

CREATE TABLE child (
    id         BIGSERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    birth_year INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    active     BOOLEAN NOT NULL DEFAULT TRUE
);

-- ═══════════════════════════════════════════════════════════
-- 事件域：学习事实
-- ═══════════════════════════════════════════════════════════

CREATE TABLE learning_session (
    id              BIGSERIAL PRIMARY KEY,
    child_id        BIGINT NOT NULL REFERENCES child(id) ON DELETE CASCADE,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at        TIMESTAMPTZ,
    duration_ms     INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
    planned_minutes INTEGER,
    item_count      INTEGER NOT NULL DEFAULT 0,
    story_count     INTEGER NOT NULL DEFAULT 0,
    completion      NUMERIC(4,3),
    quit_reason     TEXT,
    device          TEXT
);

CREATE INDEX learning_session_child_idx ON learning_session (child_id, started_at DESC);

-- 学习系统唯一事实入口（ADR-0004）
CREATE TABLE attempt (
    id                BIGSERIAL PRIMARY KEY,
    uuid              UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    session_id        BIGINT REFERENCES learning_session(id) ON DELETE SET NULL,
    child_id          BIGINT NOT NULL REFERENCES child(id) ON DELETE CASCADE,
    item_code         TEXT NOT NULL REFERENCES item(code),
    competency_code   TEXT NOT NULL REFERENCES competency(code),
    pattern_code      TEXT NOT NULL REFERENCES problem_pattern(code),
    slot_code         TEXT,
    -- item 属性快照（P2 补列）：scaffold_level 是 fluency 阈值与"今日发现"
    -- 的输入。attempt 是历史事实，必须不随 item 内容漂移（见 ADR-0004），
    -- 因此随行落列；replay 优先读列，submitted_json 快照只兜底旧数据。
    scaffold_level    VARCHAR(16) NOT NULL DEFAULT 'direct',
    interaction_type  VARCHAR(32) NOT NULL DEFAULT 'number_pad',
    seq               BIGINT NOT NULL,               -- 单孩子内单调递增，replay 的排序键
    submitted_json    JSONB,
    correct           BOOLEAN NOT NULL,
    judgement_mismatch BOOLEAN NOT NULL DEFAULT FALSE,  -- 前端判定与服务端不一致
    -- 时间语义（ADR-0003）：thinking 由计算得出，不落库，避免两个真相
    response_time_ms  INTEGER NOT NULL CHECK (response_time_ms >= 0),
    active_time_ms    INTEGER NOT NULL CHECK (active_time_ms >= 0),
    idle_time_ms      INTEGER NOT NULL DEFAULT 0 CHECK (idle_time_ms >= 0),
    hints_used        SMALLINT NOT NULL DEFAULT 0 CHECK (hints_used >= 0),
    hint_level_max    SMALLINT NOT NULL DEFAULT 0,
    method_used       TEXT,   -- counting / decompose / make_ten / mental / written / visual_blocks / number_line
    is_assessment     BOOLEAN NOT NULL DEFAULT FALSE,  -- 冷启动 probe：权重打折且不参与升级判定
    is_transfer_probe BOOLEAN NOT NULL DEFAULT FALSE,  -- 迁移测试：给 transfer 采样
    misconception_codes_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (active_time_ms + idle_time_ms <= response_time_ms),
    UNIQUE (child_id, seq)
);

CREATE INDEX attempt_child_seq_idx ON attempt (child_id, seq);
CREATE INDEX attempt_competency_idx ON attempt (child_id, competency_code, seq);

-- append-only：算法演进与回放的原始素材
CREATE TABLE learning_event (
    id          BIGSERIAL PRIMARY KEY,
    child_id    BIGINT NOT NULL REFERENCES child(id) ON DELETE CASCADE,
    session_id  BIGINT REFERENCES learning_session(id) ON DELETE SET NULL,
    attempt_id  BIGINT REFERENCES attempt(id) ON DELETE CASCADE,
    event_type  TEXT NOT NULL,   -- answer_submitted / hint_revealed / session_started / ...
    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX learning_event_child_idx ON learning_event (child_id, id);

CREATE TABLE coach_message (
    id                  BIGSERIAL PRIMARY KEY,
    attempt_id          BIGINT REFERENCES attempt(id) ON DELETE CASCADE,
    role                TEXT NOT NULL,
    source              TEXT NOT NULL CHECK (source IN ('rule', 'llm')),
    hint_level          SMALLINT,
    text                TEXT NOT NULL,
    validator_result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    fallback_used       BOOLEAN NOT NULL DEFAULT FALSE,
    latency_ms          INTEGER,
    ts                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════
-- 状态域：熟练度（派生值不落权威）
-- ═══════════════════════════════════════════════════════════

-- 注意：这里没有 level 字段。等级永远是 derive_level(signals, algorithm_version) 的结果。
CREATE TABLE proficiency_state (
    child_id           BIGINT NOT NULL REFERENCES child(id) ON DELETE CASCADE,
    competency_code    TEXT NOT NULL REFERENCES competency(code),
    mastery            NUMERIC(5,4) CHECK (mastery IS NULL OR (mastery BETWEEN 0 AND 1)),
    accuracy           NUMERIC(5,4) CHECK (accuracy IS NULL OR (accuracy BETWEEN 0 AND 1)),
    fluency            NUMERIC(5,4) CHECK (fluency IS NULL OR (fluency BETWEEN 0 AND 1)),
    independence       NUMERIC(5,4) CHECK (independence IS NULL OR (independence BETWEEN 0 AND 1)),
    transfer           NUMERIC(5,4) CHECK (transfer IS NULL OR (transfer BETWEEN 0 AND 1)),
    confidence         NUMERIC(5,4) CHECK (confidence IS NULL OR (confidence BETWEEN 0 AND 1)),
    signal_sample_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
    sample_count       INTEGER NOT NULL DEFAULT 0,
    assessment_samples INTEGER NOT NULL DEFAULT 0,
    probe_status       TEXT NOT NULL DEFAULT 'unknown'
                       CHECK (probe_status IN ('unknown', 'probing', 'estimated', 'stable')),
    algorithm_version  INTEGER NOT NULL REFERENCES algorithm_config(version),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (child_id, competency_code)
);

-- 键含 competency：迁移 = 同一 competency 换 pattern
CREATE TABLE pattern_state (
    child_id        BIGINT NOT NULL REFERENCES child(id) ON DELETE CASCADE,
    competency_code TEXT NOT NULL REFERENCES competency(code),
    pattern_code    TEXT NOT NULL REFERENCES problem_pattern(code),
    mastery         NUMERIC(5,4),
    accuracy        NUMERIC(5,4),
    fluency         NUMERIC(5,4),
    independence    NUMERIC(5,4),
    transfer        NUMERIC(5,4),
    confidence      NUMERIC(5,4),
    signal_sample_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
    sample_count    INTEGER NOT NULL DEFAULT 0,
    algorithm_version INTEGER NOT NULL REFERENCES algorithm_config(version),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (child_id, competency_code, pattern_code)
);

CREATE TABLE misconception_state (
    child_id               BIGINT NOT NULL REFERENCES child(id) ON DELETE CASCADE,
    misconception_code     TEXT NOT NULL REFERENCES misconception(code),
    hit_count              INTEGER NOT NULL DEFAULT 0,
    last_attempt_seq       BIGINT,
    last_seen_at           TIMESTAMPTZ,
    resolved               BOOLEAN NOT NULL DEFAULT FALSE,
    remediation_competency TEXT REFERENCES competency(code),
    PRIMARY KEY (child_id, misconception_code)
);

CREATE TABLE review_schedule (
    child_id      BIGINT NOT NULL REFERENCES child(id) ON DELETE CASCADE,
    target_type   TEXT NOT NULL CHECK (target_type IN ('competency', 'pattern')),
    target_code   TEXT NOT NULL,
    stage_index   SMALLINT NOT NULL DEFAULT 0,
    interval_days INTEGER NOT NULL,
    due_at        TIMESTAMPTZ NOT NULL,
    ease          NUMERIC(4,3) NOT NULL DEFAULT 1.0,
    PRIMARY KEY (child_id, target_type, target_code)
);

CREATE INDEX review_schedule_due_idx ON review_schedule (child_id, due_at);

-- ═══════════════════════════════════════════════════════════
-- 故事域（P2 接入；P0 只建表，不产出内容）
-- ═══════════════════════════════════════════════════════════

CREATE TABLE universe (
    code            TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    theme           TEXT NOT NULL DEFAULT '',
    unlock_rule_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    order_index     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE story (
    code                 TEXT PRIMARY KEY,
    universe_code        TEXT NOT NULL REFERENCES universe(code),
    title                TEXT NOT NULL,
    summary              TEXT NOT NULL DEFAULT '',
    duration_min         SMALLINT,
    target_competencies_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    order_index          INTEGER NOT NULL DEFAULT 0
);

-- story_beat.code 约定为 "{story_code}__{local_code}"，因此它本身全局唯一，
-- 但每次读都必须能回到故事，故事 id 也必须能反查所有 beat。
CREATE TABLE story_beat (
    code         TEXT PRIMARY KEY,
    story_code   TEXT NOT NULL REFERENCES story(code) ON DELETE CASCADE,
    sequence     SMALLINT NOT NULL,
    beat_type    TEXT NOT NULL CHECK (beat_type IN ('narration', 'challenge', 'reward')),
    narration    TEXT,
    character    TEXT,
    visual_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
    reward_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (story_code, sequence)
);

-- 题目槽位：故事与题目之间的唯一桥梁（ADR-0001）
--
--   story_beat_code 为 NULL ⇒ 独立训练槽（核心训练 / 思维挑战段在用）。
--   槽位机制不属于故事，故事只是它的一种使用场景。
CREATE TABLE challenge_slot (
    code              TEXT PRIMARY KEY,
    story_beat_code   TEXT REFERENCES story_beat(code) ON DELETE CASCADE,
    competency_code   TEXT NOT NULL REFERENCES competency(code),
    pattern_code      TEXT REFERENCES problem_pattern(code),  -- NULL ⇒ 由规划器按状态决定
    difficulty_min    SMALLINT NOT NULL DEFAULT 1,
    difficulty_max    SMALLINT NOT NULL DEFAULT 5,
    scaffold_level    TEXT NOT NULL DEFAULT 'auto'
                      CHECK (scaffold_level IN ('auto', 'blocks', 'decompose', 'direct')),
    purpose           TEXT NOT NULL DEFAULT 'practice'
                      CHECK (purpose IN ('warmup', 'core', 'practice', 'story',
                                         'thinking', 'challenge', 'review', 'probe')),
    estimated_seconds INTEGER NOT NULL DEFAULT 20,
    selection_policy_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    review_policy_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
    CHECK (difficulty_min <= difficulty_max)
);

CREATE INDEX challenge_slot_beat_idx ON challenge_slot (story_beat_code);

-- ═══════════════════════════════════════════════════════════
-- 游戏域（P5 接入）
-- 游戏状态与学习状态分离，两者通过 attempt 连接；
-- 游戏状态永远不是学习状态的权威。
-- ═══════════════════════════════════════════════════════════

CREATE TABLE inventory (
    child_id BIGINT NOT NULL REFERENCES child(id) ON DELETE CASCADE,
    item_code TEXT NOT NULL,
    count    INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
    PRIMARY KEY (child_id, item_code)
);

CREATE TABLE unlock (
    child_id    BIGINT NOT NULL REFERENCES child(id) ON DELETE CASCADE,
    unlock_code TEXT NOT NULL,
    unlocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (child_id, unlock_code)
);

CREATE TABLE reward_log (
    id         BIGSERIAL PRIMARY KEY,
    child_id   BIGINT NOT NULL REFERENCES child(id) ON DELETE CASCADE,
    attempt_id BIGINT REFERENCES attempt(id) ON DELETE SET NULL,
    reward_json JSONB NOT NULL,
    ts         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════
-- 迁移的落地形态（ADR-0004）
-- 以下四张表必须由同一事务写入，不允许分步提交：
--
--   BEGIN;
--     INSERT INTO attempt ...;
--     INSERT INTO learning_event ...;
--     INSERT INTO reward_log ...;
--     UPDATE proficiency_state / pattern_state / misconception_state / review_schedule ...;
--   COMMIT;
-- ═══════════════════════════════════════════════════════════

COMMIT;
