"""Health-эндпоинты: критерий приёмки №19 (проект запускается через Docker Compose)."""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient


@pytest_asyncio.fixture
async def client() -> AsyncIterator[AsyncClient]:
    from app.main import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


async def test_health_returns_ok(client: AsyncClient) -> None:
    response = await client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "ПУЛЬС"


async def test_health_v1_returns_ok(client: AsyncClient) -> None:
    response = await client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


async def test_every_response_has_request_id(client: AsyncClient) -> None:
    """Трассировка запросов нужна для связки логов и обращений в поддержку."""
    response = await client.get("/health")
    assert response.headers.get("X-Request-ID")


async def test_incoming_request_id_is_reused(client: AsyncClient) -> None:
    response = await client.get("/health", headers={"X-Request-ID": "trace-me-123"})
    assert response.headers["X-Request-ID"] == "trace-me-123"


async def test_unknown_route_returns_structured_error(client: AsyncClient) -> None:
    """Фронтенд читает error.code — формат ответа должен быть единым."""
    response = await client.get("/api/v1/definitely-not-here")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


async def test_openapi_is_available(client: AsyncClient) -> None:
    """Критерий приёмки №20 — документация через Swagger/OpenAPI."""
    response = await client.get("/openapi.json")
    assert response.status_code == 200
    assert response.json()["info"]["title"] == "ПУЛЬС"


async def test_docs_ui_is_available(client: AsyncClient) -> None:
    response = await client.get("/docs")
    assert response.status_code == 200
    assert "swagger" in response.text.lower()


async def test_api_root_reports_stage(client: AsyncClient) -> None:
    response = await client.get("/api/v1/")
    assert response.status_code == 200
    assert response.json()["docs"] == "/docs"


@pytest.mark.parametrize(
    ("path", "expected_code"),
    [
        ("/api/v1/", None),
        ("/health", None),
    ],
)
async def test_public_endpoints_need_no_auth(path: str, expected_code: str | None) -> None:
    """Health-эндпоинты остаются открытыми — иначе Docker healthcheck не пройдёт."""
    from httpx import ASGITransport, AsyncClient

    from app.main import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        response = await ac.get(path)
        assert response.status_code == 200
        if expected_code:
            assert response.json()["error"]["code"] == expected_code
