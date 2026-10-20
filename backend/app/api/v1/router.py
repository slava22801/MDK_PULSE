"""Роутеры API v1 (раздел 8 ТЗ).

Подключаются в ``app.main`` с префиксом ``/api/v1``.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.api.v1 import account, admin, auth, cart, catalog, orders, preferences
from app.core.config import settings

api_router = APIRouter()

api_router.include_router(auth.router)
api_router.include_router(catalog.router)
api_router.include_router(cart.router)
api_router.include_router(preferences.router)
api_router.include_router(account.router)
api_router.include_router(orders.router)
api_router.include_router(admin.staff_router)
api_router.include_router(admin.stock_router)
api_router.include_router(admin.admin_router)


@api_router.get("/", tags=["Служебные"], summary="Информация об API")
async def api_root() -> dict[str, str]:
    return {
        "service": settings.app_name,
        "version": "0.1.0",
        "docs": "/docs",
        "stage": "6 — админ-панель",
    }
