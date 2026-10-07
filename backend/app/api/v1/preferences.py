"""Избранное и сравнение (разделы 8.7 и 8.5 ТЗ).

Избранное требует авторизации: гостю оно живёт в localStorage, и сервер
хранить его негде (раздел 5.6 ТЗ). Сравнение доступно всем — это публичная
функция витрины.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, status

from app.core.deps import CurrentUser, DbSession
from app.schemas.preferences import (
    CompareRequest,
    CompareResponse,
    FavoriteListResponse,
    FavoriteStateResponse,
)
from app.services.compare import CompareService
from app.services.favorites import FavoritesService

router = APIRouter(tags=["Избранное и сравнение"])


# ── Избранное ──


@router.get(
    "/favorites",
    response_model=FavoriteListResponse,
    summary="Список избранного",
)
async def list_favorites(user: CurrentUser, session: DbSession) -> FavoriteListResponse:
    """Избранное с признаком изменения цены с момента добавления (5.6)."""
    return await FavoritesService(session).list_favorites(user)


@router.post(
    "/favorites/{product_id}",
    response_model=FavoriteStateResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Добавить в избранное",
)
async def add_favorite(
    product_id: uuid.UUID,
    user: CurrentUser,
    session: DbSession,
) -> FavoriteStateResponse:
    return await FavoritesService(session).add(user, product_id)


@router.delete(
    "/favorites/{product_id}",
    response_model=FavoriteStateResponse,
    summary="Убрать из избранного",
)
async def remove_favorite(
    product_id: uuid.UUID,
    user: CurrentUser,
    session: DbSession,
) -> FavoriteStateResponse:
    return await FavoritesService(session).remove(user, product_id)


# ── Сравнение ──


@router.post(
    "/compare",
    response_model=CompareResponse,
    summary="Сравнить товары",
)
async def compare(
    payload: CompareRequest,
    session: DbSession,
) -> CompareResponse:
    """Таблица сравнения с подсветкой отличающихся параметров (раздел 5.5).

    Ограничения: не больше четырёх товаров и только одна категория.
    Нарушение — 400 с кодом ``too_many_products_to_compare`` либо
    ``mixed_categories``, а не молчаливое усечение списка.
    """
    return await CompareService(session).compare(payload.product_ids)
