/**
 * 请求体校验 —— `backend/api/schemas.py`（pydantic v2）的 TypeScript 手写等价。
 *
 * 只描述**请求**。响应一律用普通对象组装 —— 响应形状由契约文档与测试锁定。
 *
 * 与 pydantic 的对齐点：
 *   - 字段检查顺序 = 模型字段定义顺序（决定"第一个错误"是谁，错误只报第一个）；
 *   - lax 语义：int 字段接受整数值 number / 整数字符串，拒绝 bool 与小数；
 *     bool 字段接受 boolean / 0/1 / "true"/"false" 等常见字面量；
 *   - `Optional[X] = None`：缺键与显式 null 都等价于 None；
 *   - 约束（ge/le/min_length/max_length）在类型检查之后；
 *   - TelemetryIn 的 model_validator：active + idle 不能大于 response。
 *
 * msg 文案逐字取自 pydantic v2 的英文默认（api-contract 对拍时按 code/status
 * 断言，message 归一化规则见 tests/contract/api-contract 对拍说明）。
 */
import { validationError } from "@/src/api/http";

export interface TelemetryIn {
  response_time_ms: number;
  active_time_ms: number;
  idle_time_ms: number;
}

export interface SessionCreateIn {
  child_id: number | null;
  planned_minutes: number | null;
  device: string | null;
}

export interface SessionEndIn {
  quit_reason: string;
}

export interface AttemptIn {
  client_attempt_id: string;
  child_id: number;
  item_code: string;
  answer: unknown;
  session_id: number | null;
  slot_code: string | null;
  client_correct: boolean | null;
  hints_used: number;
  hint_level_max: number;
  method_used: string | null;
  is_transfer_probe: boolean;
  is_assessment: boolean;
  telemetry: TelemetryIn;
}

export interface HintIn {
  child_id: number | null;
  item_code: string;
  hints_used: number;
  last_answer: unknown;
}

export interface DetectiveAnswerIn {
  child_id: number | null;
  puzzle_id: string;
  answer: unknown;
  client_attempt_id: string | null;
}

export interface BuildIn {
  child_id: number | null;
  building_code: string;
}

// ── 基元校验（pydantic v2 lax 语义） ──────────────────────

const INT_TEXT_RE = /^[+-]?\d+$/;

function requireField(body: Record<string, unknown>, key: string): unknown {
  if (!Object.hasOwn(body, key)) {
    throw validationError(`body.${key}`, "Field required");
  }
  return body[key];
}

function optionalField(body: Record<string, unknown>, key: string): unknown {
  const value = body[key];
  return value === undefined ? null : value;
}

/** 非 Optional、带默认值的字段：缺键给默认，显式 null 要报错（pydantic 语义） */
function fieldOrDefault(body: Record<string, unknown>, key: string, fallback: unknown): unknown {
  if (!Object.hasOwn(body, key)) {
    return fallback;
  }
  return body[key];
}

function asInt(value: unknown, location: string): number {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && INT_TEXT_RE.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  if (typeof value === "boolean") {
    throw validationError(location, "Input should be a valid integer");
  }
  throw validationError(location, "Input should be a valid integer, unable to parse string as an integer");
}

function asString(value: unknown, location: string): string {
  if (typeof value === "string") {
    return value;
  }
  throw validationError(location, "Input should be a valid string");
}

function asBool(value: unknown, location: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === 0 || value === 1) {
    return value === 1;
  }
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (["true", "yes", "on", "y", "t", "1"].includes(text)) return true;
    if (["false", "no", "off", "n", "f", "0"].includes(text)) return false;
  }
  throw validationError(location, "Input should be a valid boolean");
}

function ensureIntRange(
  value: number,
  location: string,
  opts: { ge?: number; le?: number },
): number {
  if (opts.ge !== undefined && value < opts.ge) {
    throw validationError(location, `Input should be greater than or equal to ${opts.ge}`);
  }
  if (opts.le !== undefined && value > opts.le) {
    throw validationError(location, `Input should be less than or equal to ${opts.le}`);
  }
  return value;
}

function ensureStringLength(value: string, location: string, opts: { min?: number; max?: number }): string {
  if (opts.min !== undefined && value.length < opts.min) {
    throw validationError(location, `String should have at least ${opts.min} character${opts.min === 1 ? "" : "s"}`);
  }
  if (opts.max !== undefined && value.length > opts.max) {
    throw validationError(location, `String should have at most ${opts.max} characters`);
  }
  return value;
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw validationError("body", "Input should be a valid dictionary or object to extract fields from");
}

// ── 各请求体 ──────────────────────────────────────────────

export function parseTelemetryIn(raw: unknown, prefix = "body.telemetry"): TelemetryIn {
  const body = asObject(raw);
  const response_time_ms = ensureIntRange(
    asInt(requireField(body, "response_time_ms"), `${prefix}.response_time_ms`),
    `${prefix}.response_time_ms`,
    { ge: 0 },
  );
  const active_time_ms = ensureIntRange(
    asInt(requireField(body, "active_time_ms"), `${prefix}.active_time_ms`),
    `${prefix}.active_time_ms`,
    { ge: 0 },
  );
  const idle_time_ms = ensureIntRange(
    asInt(fieldOrDefault(body, "idle_time_ms", 0), `${prefix}.idle_time_ms`),
    `${prefix}.idle_time_ms`,
    { ge: 0 },
  );
  // ADR-0003：response = active + thinking + idle，三项必须自洽
  if (active_time_ms + idle_time_ms > response_time_ms) {
    throw validationError(
      prefix,
      "Value error, active_time_ms + idle_time_ms 不能大于 response_time_ms",
    );
  }
  return { response_time_ms, active_time_ms, idle_time_ms };
}

export function parseSessionCreateIn(raw: unknown): SessionCreateIn {
  const body = asObject(raw);
  const child_id = optionalField(body, "child_id");
  const plannedRaw = optionalField(body, "planned_minutes");
  return {
    child_id: child_id === null ? null : asInt(child_id, "body.child_id"),
    planned_minutes:
      plannedRaw === null ? null : ensureIntRange(asInt(plannedRaw, "body.planned_minutes"), "body.planned_minutes", { ge: 1, le: 120 }),
    device: optionalField(body, "device") === null ? null : asString(optionalField(body, "device"), "body.device"),
  };
}

export function parseSessionEndIn(raw: unknown): SessionEndIn {
  const body = asObject(raw);
  const quitRaw = fieldOrDefault(body, "quit_reason", "completed");
  return {
    quit_reason: asString(quitRaw, "body.quit_reason"),
  };
}

export function parseAttemptIn(raw: unknown): AttemptIn {
  const body = asObject(raw);
  const client_attempt_id = ensureStringLength(
    asString(requireField(body, "client_attempt_id"), "body.client_attempt_id"),
    "body.client_attempt_id",
    { min: 1, max: 64 },
  );
  const child_id = asInt(requireField(body, "child_id"), "body.child_id");
  const item_code = ensureStringLength(
    asString(requireField(body, "item_code"), "body.item_code"),
    "body.item_code",
    { min: 1 },
  );
  const answer = requireField(body, "answer");
  const session_id = optionalField(body, "session_id");
  const slot_code = optionalField(body, "slot_code");
  const client_correct = optionalField(body, "client_correct");
  const hints_used = ensureIntRange(
    asInt(fieldOrDefault(body, "hints_used", 0), "body.hints_used"),
    "body.hints_used",
    { ge: 0 },
  );
  const hint_level_max = ensureIntRange(
    asInt(fieldOrDefault(body, "hint_level_max", 0), "body.hint_level_max"),
    "body.hint_level_max",
    { ge: 0 },
  );
  const method_used = optionalField(body, "method_used");
  const is_transfer_probe = fieldOrDefault(body, "is_transfer_probe", false);
  const is_assessment = fieldOrDefault(body, "is_assessment", false);
  const telemetry = parseTelemetryIn(requireField(body, "telemetry"));
  return {
    client_attempt_id,
    child_id,
    item_code,
    answer,
    session_id: session_id === null ? null : asInt(session_id, "body.session_id"),
    slot_code: slot_code === null ? null : asString(slot_code, "body.slot_code"),
    client_correct: client_correct === null ? null : asBool(client_correct, "body.client_correct"),
    hints_used,
    hint_level_max,
    method_used: method_used === null ? null : asString(method_used, "body.method_used"),
    is_transfer_probe: asBool(is_transfer_probe, "body.is_transfer_probe"),
    is_assessment: asBool(is_assessment, "body.is_assessment"),
    telemetry,
  };
}

export function parseHintIn(raw: unknown): HintIn {
  const body = asObject(raw);
  const child_id = optionalField(body, "child_id");
  const item_code = ensureStringLength(
    asString(requireField(body, "item_code"), "body.item_code"),
    "body.item_code",
    { min: 1 },
  );
  const hints_used = ensureIntRange(
    asInt(fieldOrDefault(body, "hints_used", 0), "body.hints_used"),
    "body.hints_used",
    { ge: 0 },
  );
  return {
    child_id: child_id === null ? null : asInt(child_id, "body.child_id"),
    item_code,
    hints_used,
    last_answer: optionalField(body, "last_answer"),
  };
}

export function parseDetectiveAnswerIn(raw: unknown): DetectiveAnswerIn {
  const body = asObject(raw);
  const child_id = optionalField(body, "child_id");
  const puzzle_id = ensureStringLength(
    asString(requireField(body, "puzzle_id"), "body.puzzle_id"),
    "body.puzzle_id",
    { min: 1 },
  );
  const answer = requireField(body, "answer");
  const client_attempt_id = optionalField(body, "client_attempt_id");
  return {
    child_id: child_id === null ? null : asInt(child_id, "body.child_id"),
    puzzle_id,
    answer,
    client_attempt_id:
      client_attempt_id === null ? null : asString(client_attempt_id, "body.client_attempt_id"),
  };
}

export function parseBuildIn(raw: unknown): BuildIn {
  const body = asObject(raw);
  const child_id = optionalField(body, "child_id");
  const building_code = ensureStringLength(
    asString(requireField(body, "building_code"), "body.building_code"),
    "body.building_code",
    { min: 1 },
  );
  return {
    child_id: child_id === null ? null : asInt(child_id, "body.child_id"),
    building_code,
  };
}
