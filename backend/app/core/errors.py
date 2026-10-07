"""Единый формат ошибок API (раздел 9 ТЗ: ошибки должны быть понятны пользователю).

Фронтенд читает ``code`` для ветвления и ``message`` для показа,
``fields`` — для подсветки полей формы.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger(__name__)


class AppError(Exception):
    """Базовый доменный сбой. Наследники задают HTTP-код и машиночитаемый код."""

    status_code: int = status.HTTP_400_BAD_REQUEST
    code: str = "bad_request"
    message: str = "Некорректный запрос"

    def __init__(
        self,
        message: str | None = None,
        *,
        code: str | None = None,
        status_code: int | None = None,
        fields: dict[str, str] | None = None,
    ) -> None:
        self.message = message or self.message
        self.code = code or self.code
        self.status_code = status_code or self.status_code
        self.fields = fields or {}
        super().__init__(self.message)


class BadRequestError(AppError):
    status_code = status.HTTP_400_BAD_REQUEST
    code = "bad_request"
    message = "Некорректный запрос"


class UnauthorizedError(AppError):
    status_code = status.HTTP_401_UNAUTHORIZED
    code = "unauthorized"
    message = "Требуется авторизация"


class ForbiddenError(AppError):
    status_code = status.HTTP_403_FORBIDDEN
    code = "forbidden"
    message = "Недостаточно прав"


class NotFoundError(AppError):
    status_code = status.HTTP_404_NOT_FOUND
    code = "not_found"
    message = "Ресурс не найден"


class ConflictError(AppError):
    status_code = status.HTTP_409_CONFLICT
    code = "conflict"
    message = "Конфликт состояния"


class ValidationFailedError(AppError):
    status_code = 422
    code = "validation_error"
    message = "Проверьте правильность заполнения полей"


class InsufficientStockError(ConflictError):
    """Раздел 5.8 ТЗ.

    Текст приводится дословно: «Доступно только N единиц товара». Это
    пользовательская формулировка из ТЗ, её видят и покупатель, и
    разработчик в тестах, поэтому менять её нельзя.
    """

    code = "insufficient_stock"

    def __init__(self, product_name: str, available: int) -> None:
        super().__init__(
            f"Доступно только {available} {_plural(available, 'единица', 'единицы', 'единиц')} "
            f"товара: «{product_name}»."
        )
        self.available = available
        self.product_name = product_name


class RateLimitError(AppError):
    status_code = status.HTTP_429_TOO_MANY_REQUESTS
    code = "rate_limited"
    message = "Слишком много запросов. Попробуйте позже"


def _plural(number: int, one: str, few: str, many: str) -> str:
    """Русские формы числительных: 1 единица / 2 единицы / 5 единиц."""
    n = abs(number) % 100
    if 11 <= n <= 14:
        return many
    n %= 10
    if n == 1:
        return one
    if 2 <= n <= 4:
        return few
    return many


def _payload(code: str, message: str, fields: dict[str, str] | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {"error": {"code": code, "message": message}}
    if fields:
        body["error"]["fields"] = fields
    return body


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=_payload(exc.code, exc.message, exc.fields),
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        fields: dict[str, str] = {}
        for item in exc.errors():
            location = [str(p) for p in item.get("loc", []) if p not in ("body", "query", "path")]
            fields[".".join(location) or "_root"] = item.get("msg", "некорректное значение")
        return JSONResponse(
            status_code=422,
            content=_payload(
                ValidationFailedError.code,
                ValidationFailedError.message,
                fields,
            ),
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {401: "unauthorized", 403: "forbidden", 404: "not_found"}.get(
            exc.status_code, "http_error"
        )
        return JSONResponse(
            status_code=exc.status_code,
            content=_payload(code, str(exc.detail)),
            headers=getattr(exc, "headers", None),
        )

    @app.exception_handler(IntegrityError)
    async def _integrity_error(_: Request, exc: IntegrityError) -> JSONResponse:
        # Текст отдаём обезличенным: он может содержать значения уникальных индексов.
        logger.warning("Нарушение целостности данных: %s", type(exc.orig).__name__)
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content=_payload("conflict", "Запись нарушает ограничения целостности данных"),
        )

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception) -> JSONResponse:
        logger.exception("Необработанная ошибка: %s", type(exc).__name__)
        # В production детали не отдаём наружу — только в лог (раздел 10 ТЗ).
        message = (
            "Внутренняя ошибка сервера. Попробуйте позже."
            if not _debug_enabled()
            else f"{type(exc).__name__}: {exc}"
        )
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content=_payload("internal_error", message),
        )


def _debug_enabled() -> bool:
    from app.core.config import settings

    return settings.debug
