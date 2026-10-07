"""Роутеры личного кабинета (раздел 5.11 ТЗ)."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Query, status

from app.core.deps import CurrentUser, DbSession
from app.schemas.account import (
    AddressCreate,
    AddressOut,
    AddressUpdate,
    OrderDetailResponse,
    OrderListResponse,
    ProfileResponse,
    ProfileUpdate,
)
from app.services.account import AccountService, update_profile

router = APIRouter(prefix="/me", tags=["Личный кабинет"])


@router.get("", response_model=ProfileResponse, summary="Профиль")
async def get_profile(user: CurrentUser) -> ProfileResponse:
    return ProfileResponse(
        id=user.id,
        email=user.email,
        first_name=user.first_name,
        last_name=user.last_name,
        phone=user.phone,
        role=user.role.value,
        email_verified=user.email_verified,
        created_at=user.created_at,
    )


@router.patch("", response_model=ProfileResponse, summary="Изменить профиль")
async def patch_profile(
    payload: ProfileUpdate,
    user: CurrentUser,
    session: DbSession,
) -> ProfileResponse:
    updated = await update_profile(session, user, payload)
    return ProfileResponse(
        id=updated.id,
        email=updated.email,
        first_name=updated.first_name,
        last_name=updated.last_name,
        phone=updated.phone,
        role=updated.role.value,
        email_verified=updated.email_verified,
        created_at=updated.created_at,
    )


# ── Адреса ──


@router.get("/addresses", response_model=list[AddressOut], summary="Адреса доставки")
async def list_addresses(
    user: CurrentUser,
    session: DbSession,
) -> list[AddressOut]:
    addresses = await AccountService(session).list_addresses(user)
    return [AddressOut.model_validate(address, from_attributes=True) for address in addresses]


@router.post(
    "/addresses",
    response_model=AddressOut,
    status_code=status.HTTP_201_CREATED,
    summary="Добавить адрес",
)
async def create_address(
    payload: AddressCreate,
    user: CurrentUser,
    session: DbSession,
) -> AddressOut:
    address = await AccountService(session).create_address(user, payload)
    return AddressOut.model_validate(address, from_attributes=True)


@router.patch("/addresses/{address_id}", response_model=AddressOut, summary="Изменить адрес")
async def update_address(
    address_id: uuid.UUID,
    payload: AddressUpdate,
    user: CurrentUser,
    session: DbSession,
) -> AddressOut:
    address = await AccountService(session).update_address(user, address_id, payload)
    return AddressOut.model_validate(address, from_attributes=True)


@router.delete(
    "/addresses/{address_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Удалить адрес",
)
async def delete_address(
    address_id: uuid.UUID,
    user: CurrentUser,
    session: DbSession,
) -> None:
    await AccountService(session).delete_address(user, address_id)


# ── История заказов ──


@router.get("/orders", response_model=OrderListResponse, summary="История заказов")
async def list_orders(
    user: CurrentUser,
    session: DbSession,
    page: Annotated[int, Query(ge=1)] = 1,
    limit: Annotated[int, Query(ge=1, le=50)] = 10,
) -> OrderListResponse:
    """История заказов.

    Список отдаётся без состава позиций: история грузится одним запросом,
    а состав каждого заказа запрашивается отдельно по ``/orders/{id}``.
    """
    return await AccountService(session).list_orders(user, page, limit)


@router.get("/orders/{order_id}", response_model=OrderDetailResponse, summary="Детали заказа")
async def get_order(
    order_id: uuid.UUID,
    user: CurrentUser,
    session: DbSession,
) -> OrderDetailResponse:
    return await AccountService(session).get_order(user, order_id)
