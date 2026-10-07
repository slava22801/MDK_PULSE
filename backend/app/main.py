"""Точка входа приложения «ПУЛЬС».

Здесь собирается FastAPI-приложение: middleware, обработчики ошибок,
роутеры API и health-эндпоинты для Docker healthcheck.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from redis.asyncio import Redis
from sqlalchemy import text

from app.api.v1.router import api_router
from app.core.config import CART_COOKIE, CART_COOKIE_MAX_AGE, settings
from app.core.errors import register_exception_handlers
from app.core.logging import configure_logging
from app.db.session import dispose_engine, engine

logger = logging.getLogger(__name__)

REQUEST_ID_HEADER = "X-Request-ID"


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    configure_logging()
    logger.info(
        "Запуск %s | env=%s | debug=%s",
        settings.app_name,
        settings.app_env,
        settings.debug,
    )
    yield
    await dispose_engine()
    logger.info("Приложение остановлено")


def create_app() -> FastAPI:
    app = FastAPI(
        title=settings.app_name,
        description="API интернет-магазина компьютерных комплектующих.",
        version="0.1.0",
        docs_url="/docs",
        redoc_url="/redoc",
        openapi_url="/openapi.json",
        lifespan=lifespan,
    )

    # Раздел 10 ТЗ: CORS только с разрешённых доменов.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", REQUEST_ID_HEADER, "Idempotency-Key"],
        expose_headers=[REQUEST_ID_HEADER],
        max_age=3600,
    )

    @app.middleware("http")
    async def cart_session_cookie(request: Request, call_next):
        """Гарантирует наличие cookie гостевой корзины (раздел 5.8 ТЗ).

        Без неё гостю некуда положить корзину: идентификатор выдаётся при
        первом же обращении и не подменяется, пока покупатель не очистит
        cookie. Cookie ставится только если её ещё нет, поэтому не сбрасывает
        корзину при каждом запросе.
        """
        cart_cookie = request.cookies.get(CART_COOKIE)
        new_cart_cookie = None if cart_cookie else uuid.uuid4().hex
        if new_cart_cookie:
            request.state.cart_session = new_cart_cookie
        else:
            request.state.cart_session = cart_cookie

        response = await call_next(request)

        if new_cart_cookie:
            response.set_cookie(
                key=CART_COOKIE,
                value=new_cart_cookie,
                max_age=CART_COOKIE_MAX_AGE,
                httponly=True,
                samesite="lax",
                secure=settings.is_production,
                path="/",
            )
        return response

    @app.middleware("http")
    async def request_context(
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        """Проставляет request_id и замеряет длительность — это попадает в логи."""
        request_id = request.headers.get(REQUEST_ID_HEADER) or uuid.uuid4().hex
        request.state.request_id = request_id
        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            duration_ms = round((time.perf_counter() - started) * 1000, 2)
            logger.exception(
                "%s %s | 500 | %.2fms | request_id=%s",
                request.method,
                request.url.path,
                duration_ms,
                request_id,
            )
            raise
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        response.headers[REQUEST_ID_HEADER] = request_id
        logger.info(
            "%s %s | %s | %.2fms | request_id=%s",
            request.method,
            request.url.path,
            response.status_code,
            duration_ms,
            request_id,
        )
        return response

    register_exception_handlers(app)

    @app.get("/health", tags=["Служебные"], summary="Liveness — приложение отвечает")
    async def health() -> dict[str, str]:
        return {"status": "ok", "service": settings.app_name, "env": settings.app_env}

    @app.get("/api/v1/health", tags=["Служебные"], summary="Liveness + окружение")
    async def health_v1() -> dict[str, str]:
        return {"status": "ok", "service": settings.app_name, "env": settings.app_env}

    @app.get(
        "/api/v1/health/ready",
        tags=["Служебные"],
        summary="Readiness — PostgreSQL и Redis доступны",
    )
    async def readiness() -> Response:
        checks: dict[str, str] = {}
        healthy = True

        try:
            async with engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
            checks["database"] = "ok"
        except Exception as exc:  # noqa: BLE001 — health-эндпоинт обязан отвечать всегда
            checks["database"] = f"error: {type(exc).__name__}"
            healthy = False

        try:
            redis = Redis.from_url(settings.redis_url, socket_connect_timeout=2)
            try:
                await redis.ping()
                checks["redis"] = "ok"
            finally:
                await redis.aclose()
        except Exception as exc:  # noqa: BLE001
            checks["redis"] = f"error: {type(exc).__name__}"
            healthy = False

        return Response(
            status_code=200 if healthy else 503,
            content=json.dumps(
                {"status": "ready" if healthy else "degraded", "checks": checks},
                ensure_ascii=False,
            ),
            media_type="application/json",
        )

    app.include_router(api_router, prefix="/api/v1")

    # Локальный драйвер хранилища раздаётся самим backend — без внешнего
    # S3-сервиса картинки товаров всё равно доступны в dev и тестах.
    if settings.storage_driver == "local":
        from starlette.staticfiles import StaticFiles

        media_root = Path(settings.media_root).resolve()
        media_root.mkdir(parents=True, exist_ok=True)
        app.mount("/media", StaticFiles(directory=media_root), name="media")

    return app


app = create_app()
