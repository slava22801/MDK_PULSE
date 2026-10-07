"""Административная логика: заказы, пользователи, промокоды, статистика (раздел 6 ТЗ)."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.errors import BadRequestError, ConflictError, NotFoundError
from app.core.security import hash_password
from app.models.enums import DiscountType, OrderStatus, ReviewStatus, UserRole
from app.models.order import Order, OrderItem
from app.models.review import PromoCode, PromoCodeCategory, PromoCodeProduct, Review
from app.models.user import User
from app.repositories.user import UserRepository
from app.schemas.admin import (
    AdminOrderDetail,
    AdminOrderListItem,
    AdminUserListItem,
    PromoCodeCreate,
    PromoCodeUpdate,
    StatisticsResponse,
)
from app.services.audit import AuditService
from app.services.orders import OrderService

logger = logging.getLogger(__name__)

PAYMENT_STATUS_LABELS = {
    "pending": "Ожидает",
    "awaiting": "Ожидает оплаты",
    "paid": "Оплачен",
    "failed": "Ошибка оплаты",
    "refunded": "Возвращён",
    "cancelled": "Отменён",
}

DELIVERY_LABELS = {
    "courier": "Курьер",
    "pickup": "Самовывоз",
    "pickup_point": "Пункт выдачи",
    "transport_company": "Транспортная компания",
}

PAYMENT_METHOD_LABELS = {
    "card": "Банковская карта",
    "online": "Онлайн-оплата",
    "cash_on_delivery": "При получении",
    "invoice": "Счёт для юрлица",
}


class AdminOrdersService:
    """Заказы с точки зрения сотрудника (раздел 6.3)."""

    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.audit = AuditService(session)
        self.orders = OrderService(session)

    async def list_orders(
        self,
        *,
        page: int = 1,
        limit: int = 25,
        status: OrderStatus | None = None,
        search: str | None = None,
        date_from: datetime | None = None,
        date_to: datetime | None = None,
    ) -> tuple[list[AdminOrderListItem], int]:
        conditions = []
        if status is not None:
            conditions.append(Order.status == status)
        if date_from is not None:
            conditions.append(Order.created_at >= date_from)
        if date_to is not None:
            conditions.append(Order.created_at <= date_to)
        if search:
            # Поиск по номеру, имени, телефону и email (раздел 6.3).
            pattern = f"%{search.strip()}%"
            conditions.append(
                or_(
                    Order.order_number.ilike(pattern),
                    Order.customer_first_name.ilike(pattern),
                    Order.customer_last_name.ilike(pattern),
                    Order.customer_phone.ilike(pattern),
                    Order.customer_email.ilike(pattern),
                )
            )

        total = int(
            (
                await self.session.execute(
                    select(func.count()).select_from(Order).where(*conditions)
                )
            ).scalar_one()
        )

        rows = (
            (
                await self.session.execute(
                    select(Order)
                    .where(*conditions)
                    .order_by(Order.created_at.desc())
                    .offset((page - 1) * limit)
                    .limit(limit)
                    .options(selectinload(Order.items))
                )
            )
            .scalars()
            .unique()
            .all()
        )

        return [self._list_item(order) for order in rows], total

    async def _load_order(self, order_id) -> Order:
        """Читает заказ со свежими значениями.

        populate_existing=True нужен после commit: колонки вроде updated_at
        становятся просроченными, и сериализатор вызвал бы ленивую
        перезагрузку вне async-контекста.
        """
        stmt = (
            select(Order)
            .where(Order.id == order_id)
            .options(selectinload(Order.items))
            .execution_options(populate_existing=True)
        )
        order = (await self.session.execute(stmt)).scalar_one_or_none()
        if order is None:
            raise NotFoundError("Заказ не найден", code="order_not_found")
        return order

    async def get_order(self, order_id: uuid.UUID) -> AdminOrderDetail:
        return self._detail(await self._load_order(order_id))

    async def change_status(
        self,
        order_id: uuid.UUID,
        *,
        to: OrderStatus,
        actor: User,
        tracking_number: str | None = None,
        comment: str | None = None,
        ip_address: str | None = None,
    ) -> AdminOrderDetail:
        """Меняет статус по правилам статусной машины и пишет в журнал."""
        order = await self._load_order(order_id)

        previous = order.status
        await self.orders.change_status(order, to, actor=actor, comment=comment)

        if tracking_number:
            order.tracking_number = tracking_number
            await self.session.flush()

        await self.audit.record(
            actor,
            action="order.status_changed",
            entity_type="order",
            entity_id=order.id,
            details={
                "from": previous.value,
                "to": to.value,
                "tracking_number": tracking_number,
                "comment": comment,
            },
            ip_address=ip_address,
        )
        await self.session.commit()

        return self._detail(await self._load_order(order_id))

    async def add_comment(
        self,
        order_id: uuid.UUID,
        *,
        comment: str,
        actor: User,
        ip_address: str | None = None,
    ) -> AdminOrderDetail:
        order = await self._load_order(order_id)

        previous = order.manager_comment
        order.manager_comment = order.manager_comment or ""
        if order.manager_comment.strip():
            order.manager_comment += "\n"
        order.manager_comment += comment
        await self.session.flush()

        await self.audit.record(
            actor,
            action="order.comment_added",
            entity_type="order",
            entity_id=order.id,
            details={"comment": comment, "previous_length": len(previous or "")},
            ip_address=ip_address,
        )
        await self.session.commit()
        return self._detail(order)

    def _list_item(self, order: Order) -> AdminOrderListItem:
        summary = self.orders.summary_of(order)
        return AdminOrderListItem(
            **summary.model_dump(),
            customer_full_name=f"{order.customer_last_name} {order.customer_first_name}".strip(),
            customer_email=order.customer_email,
            customer_phone=order.customer_phone,
            comment=order.comment,
        )

    def _detail(self, order: Order) -> AdminOrderDetail:
        summary = self.orders.summary_of(order)
        return AdminOrderDetail(
            **summary.model_dump(),
            items=[
                {
                    "id": item.id,
                    "product_id": item.product_id,
                    "product_name": item.product_name,
                    "sku": item.sku,
                    "quantity": item.quantity,
                    "price": item.price,
                    "total_price": item.total_price,
                }
                for item in order.items
            ],
            customer_first_name=order.customer_first_name,
            customer_last_name=order.customer_last_name,
            customer_email=order.customer_email,
            customer_phone=order.customer_phone,
            delivery_address=order.delivery_address,
            comment=order.comment,
            manager_comment=order.manager_comment,
            promo_code=order.promo_code,
            can_cancel=order.status.is_cancellable_by_customer,
        )


class AdminUsersService:
    """Пользователи и роли (раздел 6.4)."""

    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.audit = AuditService(session)
        self.users = UserRepository(session)

    async def list_users(
        self,
        *,
        page: int = 1,
        limit: int = 25,
        search: str | None = None,
        role: UserRole | None = None,
        is_blocked: bool | None = None,
    ) -> tuple[list[AdminUserListItem], int]:
        conditions = []
        if search:
            pattern = f"%{search.strip().lower()}%"
            conditions.append(
                or_(
                    User.email.ilike(pattern),
                    User.phone.ilike(pattern),
                    func.lower(User.first_name).ilike(pattern),
                    func.lower(User.last_name).ilike(pattern),
                )
            )
        if role is not None:
            conditions.append(User.role == role)
        if is_blocked is True:
            conditions.append(User.blocked_at.is_not(None))
        elif is_blocked is False:
            conditions.append(User.blocked_at.is_(None))

        total = int(
            (
                await self.session.execute(
                    select(func.count()).select_from(User).where(*conditions)
                )
            ).scalar_one()
        )

        rows = (
            (
                await self.session.execute(
                    select(User)
                    .where(*conditions)
                    .order_by(User.created_at.desc())
                    .offset((page - 1) * limit)
                    .limit(limit)
                )
            )
            .scalars()
            .all()
        )

        # Количество заказов пользователя добирается одним запросом на всех:
        # поштучный подсчёт дал бы N+1 на страницу списка.
        counts = await self._orders_counts([user.id for user in rows])

        items = [
            AdminUserListItem(
                id=user.id,
                email=user.email,
                first_name=user.first_name,
                last_name=user.last_name,
                phone=user.phone,
                role=user.role,
                is_active=user.is_active,
                email_verified=user.email_verified,
                blocked_at=user.blocked_at,
                created_at=user.created_at,
                last_login_at=user.last_login_at,
                orders_count=counts.get(user.id, 0),
            )
            for user in rows
        ]
        return items, total

    async def _orders_counts(self, user_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
        if not user_ids:
            return {}
        rows = await self.session.execute(
            select(Order.user_id, func.count(Order.id))
            .where(Order.user_id.in_(user_ids))
            .group_by(Order.user_id)
        )
        return {user_id: int(count) for user_id, count in rows.all()}

    async def update_user(
        self,
        user_id: uuid.UUID,
        *,
        actor: User,
        role: UserRole | None = None,
        is_blocked: bool | None = None,
        password: str | None = None,
        ip_address: str | None = None,
    ) -> AdminUserListItem:
        target = await self.users.get_by_id(user_id)
        if target is None:
            raise NotFoundError("Пользователь не найден", code="user_not_found")

        if target.id == actor.id:
            # Снять с себя права или заблокировать себя — способ уронить админку
            # целиком, когда другой сотрудник забыл пароль.
            if role is not None and role is not actor.role:
                raise BadRequestError(
                    "Нельзя изменить собственную роль",
                    code="cannot_change_own_role",
                )
            if is_blocked:
                raise BadRequestError(
                    "Нельзя заблокировать самого себя",
                    code="cannot_block_self",
                )

        if target.role is UserRole.ADMIN and is_blocked:
            others = await self.session.execute(
                select(func.count())
                .select_from(User)
                .where(User.role == UserRole.ADMIN, User.blocked_at.is_(None))
            )
            if int(others.scalar_one()) <= 1:
                raise ConflictError(
                    "Нельзя заблокировать единственного администратора",
                    code="last_admin",
                )

        changes: dict = {}

        if role is not None and role is not target.role:
            changes["role"] = {"from": target.role.value, "to": role.value}
            target.role = role

        if is_blocked is not None:
            blocked_now = is_blocked is True
            if blocked_now and not target.blocked_at:
                changes["blocked"] = True
                target.blocked_at = datetime.now(UTC)
                target.is_active = False
                # Блокировка должна немедленно обрывать активные сессии.
                await self.users.revoke_all_sessions(target.id)
            elif not blocked_now and target.blocked_at:
                changes["blocked"] = False
                target.blocked_at = None
                target.is_active = True

        if password is not None:
            target.password_hash = hash_password(password)
            await self.users.revoke_all_sessions(target.id)
            changes["password_reset"] = True

        if not changes:
            return self._item(target)

        await self.audit.record(
            actor,
            action="user.updated",
            entity_type="user",
            entity_id=target.id,
            details={"target_email": target.email, **changes},
            ip_address=ip_address,
        )
        await self.session.commit()
        await self.session.refresh(target)
        return self._item(target)

    def _item(self, user: User) -> AdminUserListItem:
        return AdminUserListItem(
            id=user.id,
            email=user.email,
            first_name=user.first_name,
            last_name=user.last_name,
            phone=user.phone,
            role=user.role,
            is_active=user.is_active,
            email_verified=user.email_verified,
            blocked_at=user.blocked_at,
            created_at=user.created_at,
            last_login_at=user.last_login_at,
        )


class AdminPromoService:
    """Промокоды (раздел 6.5)."""

    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.audit = AuditService(session)

    async def list_promos(
        self,
        *,
        page: int = 1,
        limit: int = 25,
        is_active: bool | None = None,
    ) -> tuple[list[PromoCode], int]:
        conditions = []
        if is_active is not None:
            conditions.append(PromoCode.is_active.is_(is_active))

        total = int(
            (
                await self.session.execute(
                    select(func.count()).select_from(PromoCode).where(*conditions)
                )
            ).scalar_one()
        )
        rows = (
            (
                await self.session.execute(
                    select(PromoCode)
                    .where(*conditions)
                    .order_by(PromoCode.created_at.desc())
                    .offset((page - 1) * limit)
                    .limit(limit)
                )
            )
            .scalars()
            .all()
        )
        return list(rows), total

    async def get_promo(self, code: str) -> PromoCode:
        promo = (
            await self.session.execute(
                select(PromoCode)
                .where(PromoCode.code == code.upper())
                .options(
                    selectinload(PromoCode.categories),
                    selectinload(PromoCode.excluded),
                )
            )
        ).scalar_one_or_none()
        if promo is None:
            raise NotFoundError("Промокод не найден", code="promo_not_found")
        return promo

    async def create_promo(
        self,
        payload: PromoCodeCreate,
        *,
        actor: User,
        ip_address: str | None = None,
    ) -> PromoCode:
        existing = (
            await self.session.execute(select(PromoCode).where(PromoCode.code == payload.code))
        ).scalar_one_or_none()
        if existing is not None:
            raise ConflictError(
                "Промокод с таким кодом уже существует",
                code="promo_code_exists",
            )

        # discount_type приходит из схемы строкой (там regex-валидация),
        # а колонка модели ждёт член перечисления: без явного преобразования
        # SQLAlchemy получал бы str вместо DiscountType.
        data = payload.model_dump(exclude={"category_ids", "excluded_product_ids"})
        data["discount_type"] = DiscountType(data["discount_type"])

        promo = PromoCode(**data)
        self.session.add(promo)
        await self.session.flush()

        await self._apply_restrictions(promo, payload.category_ids, payload.excluded_product_ids)

        await self.audit.record(
            actor,
            action="promocode.created",
            entity_type="promocode",
            entity_id=promo.id,
            details={"code": promo.code, "discount_type": promo.discount_type.value},
            ip_address=ip_address,
        )
        await self.session.commit()
        return await self.get_promo(promo.code)

    async def update_promo(
        self,
        promo_id: uuid.UUID,
        payload: PromoCodeUpdate,
        *,
        actor: User,
        ip_address: str | None = None,
    ) -> PromoCode:
        promo = await self.session.get(PromoCode, promo_id)
        if promo is None:
            raise NotFoundError("Промокод не найден", code="promo_not_found")

        changes = payload.model_dump(exclude_unset=True)
        for key, value in changes.items():
            if key == "discount_type":
                from app.models.enums import DiscountType

                value = DiscountType(value)
            setattr(promo, key, value)

        await self.session.flush()
        await self.audit.record(
            actor,
            action="promocode.updated",
            entity_type="promocode",
            entity_id=promo.id,
            details={"code": promo.code, "changes": sorted(changes)},
            ip_address=ip_address,
        )
        await self.session.commit()
        return await self.get_promo(promo.code)

    async def delete_promo(
        self,
        promo_id: uuid.UUID,
        *,
        actor: User,
        ip_address: str | None = None,
    ) -> None:
        promo = await self.session.get(PromoCode, promo_id)
        if promo is None:
            raise NotFoundError("Промокод не найден", code="promo_not_found")

        code = promo.code
        await self.session.delete(promo)
        await self.session.flush()
        await self.audit.record(
            actor,
            action="promocode.deleted",
            entity_type="promocode",
            entity_id=promo_id,
            details={"code": code},
            ip_address=ip_address,
        )
        await self.session.commit()

    async def _apply_restrictions(
        self,
        promo: PromoCode,
        category_ids: list[uuid.UUID],
        excluded_product_ids: list[uuid.UUID],
    ) -> None:
        for category_id in category_ids:
            self.session.add(PromoCodeCategory(promocode_id=promo.id, category_id=category_id))
        for product_id in excluded_product_ids:
            self.session.add(PromoCodeProduct(promocode_id=promo.id, product_id=product_id))
        await self.session.flush()

    async def check_promo(
        self,
        code: str,
        total: Decimal,
        *,
        user_id: uuid.UUID | None = None,
    ) -> tuple[bool, str, Decimal]:
        """Проверка промокода без оформления заказа (раздел 8.10)."""
        from app.services.pricing import _check_promo_usable_db, money

        promo = (
            await self.session.execute(
                select(PromoCode)
                .where(PromoCode.code == code.strip().upper())
                .options(
                    selectinload(PromoCode.categories),
                    selectinload(PromoCode.excluded),
                )
            )
        ).scalar_one_or_none()
        if promo is None:
            return False, "Промокод не найден", Decimal("0")

        reason = await _check_promo_usable_db(self.session, promo, user_id, code=promo.code)
        if reason:
            return False, reason, Decimal("0")

        if Decimal(total) < promo.min_order_amount:
            return (
                False,
                f"Минимальная сумма заказа для промокода — {money(promo.min_order_amount)} ₽",
                Decimal("0"),
            )

        if promo.discount_type.value == "free_delivery":
            return True, "Промокод даёт бесплатную доставку", Decimal("0")

        if promo.discount_type.value == "percent":
            discount = Decimal(total) * promo.discount_value / Decimal("100")
        else:
            discount = promo.discount_value
        if promo.max_discount_amount is not None:
            discount = min(discount, promo.max_discount_amount)
        discount = money(min(discount, Decimal(total)))
        return True, "Промокод применим", discount


class StatisticsService:
    """Сводка по магазину (раздел 6.4)."""

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def collect(self, period_days: int = 30) -> StatisticsResponse:
        from app.models.catalog import Product
        from app.models.user import User

        since = datetime.now(UTC) - timedelta(days=period_days)

        totals = (
            await self.session.execute(
                select(
                    func.coalesce(func.sum(Order.total_amount), 0),
                    func.count(Order.id),
                ).where(Order.status == OrderStatus.COMPLETED)
            )
        ).one()

        period = (
            await self.session.execute(
                select(
                    func.coalesce(func.sum(Order.total_amount), 0),
                    func.count(Order.id),
                ).where(
                    Order.status == OrderStatus.COMPLETED,
                    Order.created_at >= since,
                )
            )
        ).one()

        by_status = dict(
            (
                await self.session.execute(
                    select(Order.status, func.count(Order.id)).group_by(Order.status)
                )
            ).all()
        )

        customers_total = int(
            (await self.session.execute(select(func.count()).select_from(User))).scalar_one()
        )
        new_customers = int(
            (
                await self.session.execute(
                    select(func.count()).select_from(User).where(User.created_at >= since)
                )
            ).scalar_one()
        )

        products_total, out_of_stock, low_stock = (
            await self.session.execute(
                select(
                    func.count(Product.id),
                    func.count(Product.id).filter(Product.stock_quantity <= 0),
                    func.count(Product.id).filter(
                        Product.stock_quantity - Product.reserved_quantity <= 5,
                        Product.stock_quantity - Product.reserved_quantity > 0,
                    ),
                )
            )
        ).one()

        reviews_pending = int(
            (
                await self.session.execute(
                    select(func.count())
                    .select_from(Review)
                    .where(Review.status == ReviewStatus.PENDING)
                )
            ).scalar_one()
        )

        best_sellers = [
            {"id": str(product.id), "name": product.name, "sku": product.sku, "sold": int(sold)}
            for product, sold in (
                await self.session.execute(
                    select(Product, func.coalesce(func.sum(OrderItem.quantity), 0))
                    .select_from(Product)
                    .join(OrderItem, OrderItem.product_id == Product.id, isouter=True)
                    .group_by(Product.id)
                    .order_by(func.coalesce(func.sum(OrderItem.quantity), 0).desc())
                    .limit(8)
                )
            ).all()
        ]

        low_stock_items = [
            {
                "id": str(product.id),
                "name": product.name,
                "sku": product.sku,
                "available": int(available),
            }
            for product, available in (
                await self.session.execute(
                    select(
                        Product,
                        Product.stock_quantity - Product.reserved_quantity,
                    )
                    .where(Product.stock_quantity - Product.reserved_quantity <= 5)
                    .order_by(Product.stock_quantity)
                    .limit(15)
                )
            ).all()
        ]

        sales_by_day = [
            {"date": str(day)[:10], "amount": str(amount), "orders": int(orders)}
            for day, amount, orders in (
                await self.session.execute(
                    select(
                        func.date_trunc("day", Order.created_at).label("day"),
                        func.coalesce(func.sum(Order.total_amount), 0).label("amount"),
                        func.count(Order.id).label("orders"),
                    )
                    .where(Order.created_at >= since)
                    .group_by("day")
                    .order_by("day")
                )
            ).all()
        ]

        completed = int(by_status.get(OrderStatus.COMPLETED, 0))
        revenue_total = Decimal(str(totals[0]))
        orders_total = int(totals[1])
        average = revenue_total / orders_total if orders_total else Decimal("0")

        return StatisticsResponse(
            revenue_total=revenue_total,
            revenue_period=Decimal(str(period[0])),
            orders_total=orders_total,
            orders_pending=int(by_status.get(OrderStatus.NEW, 0))
            + int(by_status.get(OrderStatus.AWAITING_PAYMENT, 0))
            + int(by_status.get(OrderStatus.CONFIRMED, 0)),
            orders_completed=completed,
            orders_cancelled=int(by_status.get(OrderStatus.CANCELLED, 0)),
            average_order_value=average.quantize(Decimal("0.01")),
            customers_total=customers_total,
            new_customers_period=new_customers,
            products_total=int(products_total),
            products_out_of_stock=int(out_of_stock),
            products_low_stock=int(low_stock),
            reviews_pending=reviews_pending,
            best_sellers=best_sellers,
            low_stock_items=low_stock_items,
            sales_by_day=sales_by_day,
            period_days=period_days,
        )
