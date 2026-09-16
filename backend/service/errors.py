"""API 错误。

统一错误形状（契约 §12）：

    { "error": { "code": "ITEM_NOT_FOUND", "message": "mt_blk_8_5 不存在" } }

状态码约定：400 参数错误 / 404 资源不存在 / 409 冲突 / 500 服务端错误。
4xx 一律不可重试（除 429），5xx 与网络错误可重试。
"""
from __future__ import annotations


class ApiError(Exception):
    def __init__(self, status_code: int, code: str, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message

    def to_dict(self):
        return {"error": {"code": self.code, "message": self.message}}


def bad_request(message: str, code: str = "INVALID_PARAM") -> ApiError:
    return ApiError(400, code, message)


def not_found(code: str, message: str) -> ApiError:
    return ApiError(404, code, message)


def conflict(message: str, code: str = "CONFLICT") -> ApiError:
    return ApiError(409, code, message)


def child_missing(child_id) -> ApiError:
    return not_found("CHILD_NOT_FOUND", "孩子 {} 不存在".format(child_id))


def item_missing(item_code) -> ApiError:
    return not_found("ITEM_NOT_FOUND", "{} 不存在".format(item_code))


def session_missing(session_id) -> ApiError:
    return not_found("SESSION_NOT_FOUND", "会话 {} 不存在".format(session_id))


def story_missing(story_code) -> ApiError:
    return not_found("STORY_NOT_FOUND", "故事 {} 不存在".format(story_code))


__all__ = [
    "ApiError",
    "bad_request",
    "not_found",
    "conflict",
    "child_missing",
    "item_missing",
    "session_missing",
    "story_missing",
]
