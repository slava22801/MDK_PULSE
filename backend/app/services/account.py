"""Сервис личного кабинета (раздел 5.11 ТЗ)."""

from __future__ import annotations

import logging
import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFoundError
from app.models.order import Order, OrderItem
from app.models.user import Address, User
from app.repositories.user import UserRepository
from app.schemas.account import (
    AddressCreate,
    AddressUpdate,
    OrderDetailResponse,
    OrderItemOut,
    OrderListResponse,
    OrderSummary,
)
from app.services.orders import order_status_label

logger = logging.getLogger(__name__)


class AccountService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.users = UserRepository(session)

    # ── Адреса ──

    async def list_addresses(self, user: User) -> list[Address]:
        return await self._addresses_of(user.id)

    async def _addresses_of(self, user_id: uuid.UUID) -> list[Address]:
        result = await self.session.execute(
            select(Address)
            .where(Address.user_id == user_id)
            .order_by(Address.is_default.desc(), Address.created_at.desc())
        )
        return list(result.scalars().all())

    async def create_address(self, user: User, payload: AddressCreate) -> Address:
        # Первый адрес автоматически становится основным: заставлять
        # покупателя выбирать «основной» из единственного — лишний шаг.
        existing = await self.list_addresses(user)
        is_default = payload.is_default or not existing

        address = Address(
            user_id=user.id,
            # is_default исключается из разбора: ниже он передаётся
            # отдельно, иначе поле пришло бы в конструктор дважды.
            **payload.model_dump(exclude={"is_default"}),
            is_default=is_default,
        )
        self.session.add(address)
        await self.session.flush()
        if is_default:
            await self._make_default(user.id, address.id)
        await self.session.commit()
        await self.session.refresh(address)
        return address

    async def update_address(
        self,
        user: User,
        address_id: uuid.UUID,
        payload: AddressUpdate,
    ) -> Address:
        address = await self._owned_address(user.id, address_id)
        data = payload.model_dump(exclude_unset=True)
        for field, value in data.items():
            setattr(address, field, value)

        await self.session.flush()
        if data.get("is_default"):
            await self._make_default(user.id, address.id)
        await self.session.commit()
        await self.session.refresh(address)
        return address

    async def delete_address(self, user: User, address_id: uuid.UUID) -> None:
        address = await self._owned_address(user.id, address_id)
        was_default = address.is_default
        await self.session.delete(address)
        await self.session.flush()

        # Удаление основного адреса оставило бы пользователя без адреса
        # «по умолчанию», и чек-аут перестал бы его подставлять.
        if was_default:
            remaining = await self._addresses_of(user.id)
            if remaining:
                await self._make_default(user.id, remaining[0].id)
        await self.session.commit()

    async def _owned_address(self, user_id: uuid.UUID, address_id: uuid.UUID) -> Address:
        result = await self.session.execute(
            select(Address).where(Address.id == address_id, Address.user_id == user_id)
        )
        address = result.scalar_one_or_none()
        if address is None:
            raise NotFoundError("Адрес не найден", code="address_not_found")
        return address

    async def _make_default(self, user_id: uuid.UUID, keep_id: uuid.UUID) -> None:
        """Оставляет ровно один адрес основным."""
        for address in await self._addresses_of(user_id):
            address.is_default = address.id == keep_id
        await self.session.flush()

    # ── История заказов ──

    async def list_orders(self, user: User, page: int, limit: int) -> OrderListResponse:
        conditions = [Order.user_id == user.id]

        total_result = await self.session.execute(
            select(func.count()).select_from(Order).where(*conditions)
        )
        total = int(total_result.scalar_one())

        result = await self.session.execute(
            select(Order, func.coalesce(func.sum(OrderItem.quantity), 0))
            .outerjoin(OrderItem, OrderItem.order_id == Order.id)
            .where(*conditions)
            .group_by(Order.id)
            .order_by(Order.created_at.desc())
            .offset((page - 1) * limit)
            .limit(limit)
        )
        rows = result.all()
        summaries = [self._order_summary(order, int(count)) for order, count in rows]

        return OrderListResponse(
            items=summaries,
            total=total,
            page=page,
            limit=limit,
            pages=(total + limit - 1) // limit if limit else 0,
        )

    async def get_order(self, user: User, order_id: uuid.UUID) -> OrderDetailResponse:
        result = await self.session.execute(
            select(Order).where(Order.id == order_id, Order.user_id == user.id)
        )
        order = result.scalar_one_or_none()
        if order is None:
            raise NotFoundError("Заказ не найден", code="order_not_found")

        items_result = await self.session.execute(
            select(OrderItem).where(OrderItem.order_id == order.id)
        )
        items = list(items_result.scalars().all())

        return OrderDetailResponse(
            order=self._order_summary(order, sum(item.quantity for item in items)),
            items=[OrderItemOut.model_validate(item, from_attributes=True) for item in items],
            delivery_address=order.delivery_address,
            comment=order.comment,
            manager_comment=order.manager_comment,
            # Раздел 5.11: кнопка отмены показывается, только когда отмена
            # ещё возможна по статусу заказа.
            can_cancel=order.status.is_cancellable_by_customer,
        )

    def _order_summary(self, order: Order, items_count: int) -> OrderSummary:
        return OrderSummary(
            id=order.id,
            order_number=order.order_number,
            status=order.status,
            payment_status=order.payment_status,
            payment_method=order.payment_method,
            delivery_method=order.delivery_method,
            subtotal=order.subtotal,
            discount_amount=order.discount_amount,
            delivery_cost=order.delivery_cost,
            total_amount=order.total_amount,
            items_count=items_count,
            tracking_number=order.tracking_number,
            created_at=order.created_at,
            status_label=order_status_label(order.status),
        )


async def update_profile(session: AsyncSession, user: User, payload) -> User:
    """Изменение профиля."""
    users = UserRepository(session)
    for field, value in payload.model_dump(exclude_unset=True).items():
        if value is not None:
            setattr(user, field, value)
    await users.update(user)
    await session.commit()
    await session.refresh(user)
    logger.info("Профиль обновлён: %s", user.email)
    return user
