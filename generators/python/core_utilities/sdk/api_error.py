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


# Stainless-shaped error subclasses.
#
# These extend ApiError so existing callers and instantiation sites keep
# working exactly as before. They exist so downstream consumers (and tooling
# that compares an emitted SDK against a Stainless-shaped baseline) can
# resolve the conventional error class names: APIError, APIConnectionError,
# AuthenticationError, RateLimitError, etc.
#
# Purely additive: ApiError itself is unchanged.


class APIError(ApiError):
    pass


class APIResponseValidationError(APIError):
    pass


class APIStatusError(APIError):
    pass


class APIConnectionError(APIError):
    pass


class APITimeoutError(APIConnectionError):
    pass


class BadRequestError(APIStatusError):
    pass


class AuthenticationError(APIStatusError):
    pass


class PermissionDeniedError(APIStatusError):
    pass


class NotFoundError(APIStatusError):
    pass


class ConflictError(APIStatusError):
    pass


class UnprocessableEntityError(APIStatusError):
    pass


class RateLimitError(APIStatusError):
    pass


class InternalServerError(APIStatusError):
    pass
