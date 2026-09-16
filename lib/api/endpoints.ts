import { DEFAULT_CHILD_ID } from "@/lib/config";
import { http, withQuery } from "./client";
import type {
  AttemptRequest,
  AttemptResponse,
  BuildRequest,
  BuildResponse,
  DailyPlan,
  DebugLearningState,
  DetectiveAnswerRequest,
  DetectiveAnswerResponse,
  DetectivePuzzle,
  GrowthResponse,
  HintRequest,
  HintResponse,
  LabResponse,
  ParentReport,
  SessionCreateRequest,
  SessionCreateResponse,
  SessionEndRequest,
  StoryResponse,
  WorldResponse,
} from "./types";

/**
 * 契约端点集合。一个函数对应契约里的一条接口，路径与查询参数都不在这里发明。
 * 全部走 `/v1` 前缀（契约 Base URL）。
 */

// §1 首页
export const getWorld = (childId: number = DEFAULT_CHILD_ID) =>
  http.get<WorldResponse>(withQuery("/v1/world", { child_id: childId }));

// §2 学习会话
export const createSession = (body: SessionCreateRequest) =>
  http.post<SessionCreateResponse>("/v1/sessions", body);

export const endSession = (sessionId: number, body: SessionEndRequest) =>
  http.post<{ ok: boolean }>(`/v1/sessions/${sessionId}/end`, body);

// §3 今日计划
export const getTodayPlan = (childId: number = DEFAULT_CHILD_ID, sessionId?: number | null) =>
  http.get<DailyPlan>(withQuery("/v1/plans/today", { child_id: childId, session_id: sessionId }));

// §4 提交作答
export const postAttempt = (body: AttemptRequest) =>
  http.post<AttemptResponse>("/v1/attempts", body);

// §5 教练提示
export const postHints = (body: HintRequest) => http.post<HintResponse>("/v1/coach/hints", body);

// §6 故事
export const getStory = (storyCode: string, childId: number = DEFAULT_CHILD_ID) =>
  http.get<StoryResponse>(
    withQuery(`/v1/stories/${encodeURIComponent(storyCode)}`, { child_id: childId }),
  );

// §7 实验室
export const getLab = (childId: number = DEFAULT_CHILD_ID) =>
  http.get<LabResponse>(withQuery("/v1/lab", { child_id: childId }));

// §8 侦探
export const getDetectivePuzzle = (childId: number = DEFAULT_CHILD_ID) =>
  http.get<DetectivePuzzle>(withQuery("/v1/detective/puzzle", { child_id: childId }));

export const postDetectiveAnswer = (body: DetectiveAnswerRequest) =>
  http.post<DetectiveAnswerResponse>("/v1/detective/answer", body);

// §9 成长
export const getGrowth = (childId: number = DEFAULT_CHILD_ID) =>
  http.get<GrowthResponse>(withQuery("/v1/growth", { child_id: childId }));

export const postBuild = (body: BuildRequest) =>
  http.post<BuildResponse>("/v1/growth/build", body);

// §10 家长端
export const getParentReport = (childId: number = DEFAULT_CHILD_ID, days = 7) =>
  http.get<ParentReport>(withQuery("/v1/parent/report", { child_id: childId, days }));

// §11 调试
export const getDebugLearningState = (childId: number = DEFAULT_CHILD_ID) =>
  http.get<DebugLearningState>(withQuery("/v1/debug/learning-state", { child_id: childId }));
