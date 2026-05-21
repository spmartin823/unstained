from typing import Any, Dict, Optional


class ApiError(Exception):
    headers: Optional[Dict[str, str]]
    status_code: Optional[int]
    body: Any

    def __init__(
        self,
        *,
        headers: Optional[Dict[str, str]] = None,
        status_code: Optional[int] = None,
        body: Any = None,
    ) -> None:
        self.headers = headers
        self.status_code = status_code
        self.body = body

    def __str__(self) -> str:
        return f"headers: {self.headers}, status_code: {self.status_code}, body: {self.body}"


class APIError(ApiError):
    pass


class APIConnectionError(APIError):
    pass


class APIConnectionTimeoutError(APIConnectionError):
    pass


class APIUserAbortError(APIError):
    pass


class AuthenticationError(APIError):
    pass


class UnauthorizedError(APIError):
    pass


class PermissionDeniedError(APIError):
    pass


class ForbiddenError(APIError):
    pass


class ConflictError(APIError):
    pass


class ContentTooLargeError(APIError):
    pass


class UnsupportedMediaTypeError(APIError):
    pass


class RateLimitError(APIError):
    pass


def is_abort_error(err: Any) -> bool:
    return isinstance(err, APIUserAbortError)


def handle_non_status_code_error(error: Any) -> APIError:
    if isinstance(error, APIError):
        return error
    if is_abort_error(error):
        return APIUserAbortError()
    return APIConnectionError()
