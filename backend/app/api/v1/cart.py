"""Роутеры корзины (раздел 8.5 ТЗ).

Гостевая корзина опознаётся по cookie ``pulse_cart``, которую выставляет
middleware. Для авторизованного пользователя cookie игнорируется: корзина
привязана к аккаунту (раздел 5.8 ТЗ).
"""

from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, status

from app.core.deps import CartSession, DbSession, OptionalUser
from app.schemas.cart import (
    AddToCartRequest,
    CartOut,
    UpdateCartItemRequest,
)
from app.services.cart import CartService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/cart", tags=["Корзина"])


@router.get("", response_model=CartOut, summary="Корзина")
async def get_cart(
    session: DbSession,
    user: OptionalUser,
    cart_session: CartSession,
) -> CartOut:
    return await CartService(session).get_cart(
        user=user,
        cart_session=None if user else cart_session,
    )


@router.post(
    "/items",
    response_model=CartOut,
    summary="Добавить товар в корзину",
)
async def add_item(
    payload: AddToCartRequest,
    session: DbSession,
    user: OptionalUser,
    cart_session: CartSession,
) -> CartOut:
    """Добавление с проверкой остатка.

    При нехватке товара возвращается 409 с кодом ``insufficient_stock`` и
    текстом вида «Доступно только N единиц товара» (раздел 5.8 ТЗ).
    """
    return await CartService(session).add_item(
        payload,
        user=user,
        cart_session=None if user else cart_session,
    )


@router.patch(
    "/items/{item_id}",
    response_model=CartOut,
    summary="Изменить количество",
)
async def update_item(
    item_id: uuid.UUID,
    payload: UpdateCartItemRequest,
    session: DbSession,
    user: OptionalUser,
    cart_session: CartSession,
) -> CartOut:
    return await CartService(session).update_item(
        item_id,
        payload,
        user=user,
        cart_session=None if user else cart_session,
    )


@router.delete(
    "/items/{item_id}",
    response_model=CartOut,
    summary="Удалить позицию",
)
async def remove_item(
    item_id: uuid.UUID,
    session: DbSession,
    user: OptionalUser,
    cart_session: CartSession,
) -> CartOut:
    return await CartService(session).remove_item(
        item_id,
        user=user,
        cart_session=None if user else cart_session,
    )


@router.delete(
    "",
    response_model=CartOut,
    status_code=status.HTTP_200_OK,
    summary="Очистить корзину",
)
async def clear_cart(
    session: DbSession,
    user: OptionalUser,
    cart_session: CartSession,
) -> CartOut:
    return await CartService(session).clear(
        user=user,
        cart_session=None if user else cart_session,
    )
