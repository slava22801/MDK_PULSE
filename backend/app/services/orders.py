"""Сервис заказов (разделы 5.9–5.10 ТЗ).

Статусы живут не в цепочке ``if``, а в таблице переходов: переход вне
неё отклоняется с 409, и это проверяется в одном месте, а не в
полусотне веток. Побочные эффекты перехода — резерв, списание остатка,
уведомление — описаны рядом с самим переходом.
"""

from __future__ import annotations

import logging
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.core.errors import (
    BadRequestError,
    ConflictError,
    ForbiddenError,
    NotFoundError,
)
from app.models.enums import (
    OrderStatus,
    PaymentStatus,
    UserRole,
)
from app.models.order import CartItem, Order, OrderItem, Payment
from app.models.review import PromoCode, PromoCodeUsage
from app.models.user import User
from app.payments import PaymentIntent, get_provider
from app.schemas.order import OrderCreate, OrderSummary
from app.services import pricing
from app.services.pricing import PriceBreakdown, PricedItem, money
from app.services.stock import StockService, reserved_map

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Transition:
    """Правило перехода статуса и его побочный эффект."""

    to: OrderStatus
    # Что сделать с резервом: hold — не трогать, release — снять, capture — списать.
    stock_effect: str
    notify: bool = True
    requires_role: UserRole | None = None


# Раздел 5.10 ТЗ: одиннадцать статусов и разрешённые переходы.
TRANSITIONS: dict[OrderStatus, tuple[Transition, ...]] = {
    OrderStatus.NEW: (
        Transition(OrderStatus.CONFIRMED, "hold"),
        Transition(OrderStatus.AWAITING_PAYMENT, "hold"),
        Transition(OrderStatus.CANCELLED, "release"),
    ),
    OrderStatus.CONFIRMED: (
        Transition(OrderStatus.AWAITING_PAYMENT, "hold"),
        Transition(OrderStatus.PAID, "capture"),
        Transition(OrderStatus.CANCELLED, "release"),
    ),
    OrderStatus.AWAITING_PAYMENT: (
        Transition(OrderStatus.PAID, "capture"),
        Transition(OrderStatus.CANCELLED, "release"),
    ),
    OrderStatus.PAID: (
        Transition(OrderStatus.ASSEMBLING, "hold"),
        Transition(OrderStatus.CANCELLED, "release"),
        Transition(OrderStatus.RETURNED, "hold"),
    ),
    OrderStatus.ASSEMBLING: (
        Transition(OrderStatus.SHIPPED, "hold"),
        Transition(OrderStatus.READY_FOR_PICKUP, "hold"),
        Transition(OrderStatus.CANCELLED, "release"),
        Transition(OrderStatus.RETURNED, "hold"),
    ),
    OrderStatus.SHIPPED: (
        Transition(OrderStatus.COMPLETED, "hold"),
        Transition(OrderStatus.RETURNED, "hold"),
    ),
    OrderStatus.READY_FOR_PICKUP: (
        Transition(OrderStatus.COMPLETED, "hold"),
        Transition(OrderStatus.RETURNED, "hold"),
    ),
    OrderStatus.RETURNED: (Transition(OrderStatus.REFUNDED, "return"),),
    OrderStatus.COMPLETED: (Transition(OrderStatus.RETURNED, "return"),),
    OrderStatus.CANCELLED: (),
    OrderStatus.REFUNDED: (),
}


# Человеческие подписи статусов из раздела 5.10 ТЗ. Живут на уровне модуля,
# а не в методе: ими пользуются и заказы, и личный кабинет, и письма.
# Две копии одной таблицы разъехались бы при первом же переименовании.
STATUS_LABELS: dict[OrderStatus, str] = {
    OrderStatus.NEW: "Новый",
    OrderStatus.CONFIRMED: "Подтверждён",
    OrderStatus.AWAITING_PAYMENT: "Ожидает оплаты",
    OrderStatus.PAID: "Оплачен",
    OrderStatus.ASSEMBLING: "Собирается",
    OrderStatus.SHIPPED: "Передан в доставку",
    OrderStatus.READY_FOR_PICKUP: "Готов к выдаче",
    OrderStatus.COMPLETED: "Выполнен",
    OrderStatus.CANCELLED: "Отменён",
    OrderStatus.RETURNED: "Возврат",
    OrderStatus.REFUNDED: "Возвращён",
}


def order_status_label(status: OrderStatus) -> str:
    return STATUS_LABELS.get(status, status.value)


class OrderService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.stock = StockService(session)

    # ── Создание ──

    async def create_order(
        self,
        payload: OrderCreate,
        *,
        user: User | None = None,
        cart_session: str | None = None,
        idempotency_key: str | None = None,
    ) -> Order:
        """Оформляет заказ целиком в одной транзакции.

        Повторный вызов с тем же ``idempotency_key`` возвращает уже
        созданный заказ вместо нового (раздел 10 ТЗ: защита от повторной
        отправки формы при двойном клике или перезагрузке).
        """
        if idempotency_key:
            existing = await self._find_by_idempotency(idempotency_key, user)
            if existing is not None:
                logger.info(
                    "Повторное оформление с ключом %s — вернут заказ %s",
                    idempotency_key,
                    existing.order_number,
                )
                return existing

        items = await self.cart_items(user=user, cart_session=cart_session)
        if not items:
            raise BadRequestError(
                "Корзина пуста — нечего оформлять",
                code="empty_cart",
            )

        products = await self.stock.lock_products([item.product_id for item in items])

        priced = [
            PricedItem(
                product_id=str(item.product_id),
                # Название и артикул лежат на товаре, а не на позиции корзины:
                # позиция хранит только количество (раздел 7.9 ТЗ).
                product_name=item.product.name,
                sku=item.product.sku,
                quantity=item.quantity,
                unit_price=item.product.price,
                old_price=item.product.old_price,
                category_id=str(item.product.category_id),
                weight=item.product.weight,
            )
            for item in items
        ]

        breakdown = await pricing.calculate(
            self.session,
            priced,
            delivery_method=payload.delivery_method,
            promo_code=payload.promo_code,
            user_id=str(user.id) if user else None,
            free_delivery_threshold=Decimal(settings.free_delivery_threshold or "0"),
        )

        requested = {item.product_id: item.quantity for item in items}
        await self.stock.reserve(
            requested,
            reservation_hours=settings.reservation_ttl_hours,
        )

        order = Order(
            order_number=await self._next_order_number(),
            user_id=user.id if user else None,
            status=OrderStatus.NEW,
            payment_status=PaymentStatus.PENDING,
            payment_method=payload.payment_method,
            delivery_method=payload.delivery_method,
            customer_first_name=payload.customer_first_name,
            customer_last_name=payload.customer_last_name,
            customer_email=payload.customer_email,
            customer_phone=payload.customer_phone,
            subtotal=breakdown.subtotal,
            discount_amount=breakdown.discount_amount,
            delivery_cost=breakdown.delivery_cost,
            total_amount=breakdown.total,
            promo_code=breakdown.promo_code,
            currency="RUB",
            delivery_address=(
                payload.delivery_address.model_dump(mode="json")
                if payload.delivery_address
                else None
            ),
            pickup_point_id=payload.pickup_point_id,
            comment=payload.comment,
            idempotency_key=idempotency_key,
            reservation_expires_at=self.stock.reservation_deadline(settings.reservation_ttl_hours),
        )
        self.session.add(order)
        await self.session.flush()

        for item in items:
            product = products.get(item.product_id) or item.product
            # Название и цена копируются в позицию: правка карточки товара
            # не должна менять уже оформленные заказы (критерий №25).
            self.session.add(
                OrderItem(
                    order_id=order.id,
                    product_id=product.id,
                    product_name=product.name,
                    sku=product.sku,
                    quantity=item.quantity,
                    price=product.price,
                    total_price=money(product.price * item.quantity),
                )
            )

        await self._apply_promo_usage(order, breakdown, user)
        await self._clear_cart(user=user, cart_session=cart_session)

        try:
            await self.session.commit()
        except IntegrityError as exc:
            await self.session.rollback()
            if idempotency_key:
                repeated = await self._find_by_idempotency(idempotency_key, user)
                if repeated is not None:
                    return repeated
            raise ConflictError(
                "Не удалось оформить заказ: нарушено ограничение целостности",
                code="order_conflict",
            ) from exc

        await self.session.refresh(order)
        await self._notify(
            user,
            "order_created",
            f"Заказ {order.order_number} принят",
            f"Сумма заказа: {order.total_amount} ₽. Оплата в течение суток.",
        )
        logger.info(
            "Оформлен заказ %s на %s ₽ (позиций: %s)",
            order.order_number,
            order.total_amount,
            len(items),
        )
        return order

    # ── Переходы статусов ──

    async def change_status(
        self,
        order: Order,
        to: OrderStatus,
        *,
        actor: User | None = None,
        comment: str | None = None,
    ) -> Order:
        """Меняет статус, проверяя матрицу переходов и выполняя эффекты."""
        transition = self._find_transition(order.status, to, actor)
        if transition is None:
            raise ConflictError(
                f"Нельзя перевести заказ из «{order.status.value}» в «{to.value}»",
                code="invalid_status_transition",
                fields={
                    "status": order.status.value,
                    "allowed": ", ".join(item.to.value for item in TRANSITIONS[order.status]),
                },
            )

        reserved = reserved_map(order.items)

        if transition.stock_effect == "capture":
            await self.stock.commit_sale(reserved)
            order.payment_status = PaymentStatus.PAID
        elif transition.stock_effect == "release":
            await self.stock.release(reserved)
            if to is OrderStatus.CANCELLED:
                order.cancelled_at = datetime.now(UTC)
            elif to is OrderStatus.REFUNDED:
                order.payment_status = PaymentStatus.REFUNDED
                await self.stock.return_to_stock(reserved)
        elif transition.stock_effect == "return" and to is OrderStatus.REFUNDED:
            order.payment_status = PaymentStatus.REFUNDED

        previous = order.status
        order.status = to
        if to is OrderStatus.COMPLETED:
            order.completed_at = datetime.now(UTC)
        if comment:
            order.manager_comment = comment

        await self.session.flush()
        await self.session.commit()
        await self.session.refresh(order)

        if transition.notify:
            await self._notify(
                await self._order_user(order),
                "order_status_changed",
                f"Заказ {order.order_number}: "
                f"{self.status_label(previous)} → {self.status_label(to)}",
                comment or "",
            )
        logger.info("Заказ %s: %s → %s", order.order_number, previous.value, to.value)
        return order

    def _find_transition(
        self,
        current: OrderStatus,
        to: OrderStatus,
        actor: User | None,
    ) -> Transition | None:
        for transition in TRANSITIONS.get(current, ()):
            if transition.to is not to:
                continue
            # Отмена клиентом и возврат товара администратором — разные права:
            # покупателю нельзя оформить возврат самостоятельно.
            if transition.requires_role is not None:
                if actor is None or not actor.role.is_staff:
                    raise ForbiddenError(
                        "Это действие доступно только сотруднику",
                        code="insufficient_role",
                    )
            return transition
        return None

    # ── Действия покупателя ──

    async def cancel_order(self, order: Order, user: User | None) -> Order:
        """Отмена заказа покупателем (раздел 5.11)."""
        if user is not None and order.user_id != user.id:
            # Чужой заказ выглядит как отсутствующий: иначе можно перебором
            # узнать, что заказ с таким номером существует.
            raise NotFoundError("Заказ не найден", code="order_not_found")
        if not order.status.is_cancellable_by_customer:
            raise ConflictError(
                f"Заказ в статусе «{self.status_label(order.status)}» уже нельзя отменить",
                code="order_not_cancellable",
            )
        return await self.change_status(order, OrderStatus.CANCELLED)

    async def reorder(self, order: Order, user: User | None) -> Order:
        """Повторный заказ: возврат позиций в корзину (раздел 5.11)."""
        if user is None or order.user_id != user.id:
            raise ForbiddenError(
                "Повторный заказ доступен только из личного кабинета",
                code="reorder_requires_account",
            )

        restored = 0
        for item in order.items:
            if item.product_id is None:
                continue
            product = await self.session.get(Product, item.product_id)
            if product is None or not product.is_purchasable:
                continue
            # Кладём сколько реально есть, а не сколько было в прошлом заказе:
            # повторный заказ на несуществующий остаток должен честно обрезаться.
            quantity = min(item.quantity, product.available_quantity)
            if quantity <= 0:
                continue
            existing = (
                await self.session.execute(
                    select(CartItem).where(
                        CartItem.user_id == user.id,
                        CartItem.product_id == product.id,
                    )
                )
            ).scalar_one_or_none()
            if existing is not None:
                existing.quantity = min(existing.quantity + quantity, 99)
            else:
                self.session.add(
                    CartItem(
                        user_id=user.id,
                        product_id=product.id,
                        quantity=quantity,
                    )
                )
            restored += 1

        await self.session.commit()
        if restored == 0:
            raise ConflictError(
                "Ни один товар из заказа сейчас недоступен — повторить нечего",
                code="nothing_to_reorder",
            )
        return order

    # ── Чтение ──

    async def list_orders(
        self,
        *,
        user: User | None = None,
        page: int = 1,
        limit: int = 10,
        status: OrderStatus | None = None,
    ) -> tuple[list[OrderSummary], int]:
        conditions = []
        if user is not None:
            conditions.append(Order.user_id == user.id)
        if status is not None:
            conditions.append(Order.status == status)

        total = int(
            (
                await self.session.execute(
                    select(func.count()).select_from(Order).where(*conditions)
                )
            ).scalar_one()
        )

        result = await self.session.execute(
            select(Order)
            .where(*conditions)
            .order_by(Order.created_at.desc())
            .offset((page - 1) * limit)
            .limit(limit)
            .options(selectinload(Order.items))
        )
        orders = list(result.scalars().unique().all())
        summaries = [self.summary_of(order) for order in orders]
        return summaries, total

    async def get_for_user(self, order_id: uuid.UUID, user: User | None) -> Order:
        order = await self.session.get(
            Order,
            order_id,
            options=(selectinload(Order.items),),
        )
        if order is None:
            raise NotFoundError("Заказ не найден", code="order_not_found")
        if order.user_id is None or user is None or order.user_id != user.id:
            raise NotFoundError("Заказ не найден", code="order_not_found")
        return order

    def summary_of(self, order: Order) -> OrderSummary:
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
            items_count=sum(item.quantity for item in order.items),
            tracking_number=order.tracking_number,
            created_at=order.created_at,
            status_label=self.status_label(order.status),
        )

    # ── Оплата ──

    async def start_payment(self, order: Order) -> PaymentIntent:
        """Создаёт платёж у провайдера и сохраняет попытку оплаты."""
        if order.payment_status is PaymentStatus.PAID:
            raise ConflictError("Заказ уже оплачен", code="already_paid")
        if order.status.is_final:
            # Отменённый или завершённый заказ оплачивать нельзя: деньги
            # уйдут в никуда, а заказ останется в неизменном виде.
            raise ConflictError(
                f"Заказ в статусе «{self.status_label(order.status)}» оплатить нельзя",
                code="order_not_payable",
            )

        provider = get_provider()
        intent = await provider.create_payment(
            order_id=order.id,
            order_number=order.order_number,
            amount=order.total_amount,
            email=order.customer_email,
            description=f"Заказ {order.order_number} в магазине «ПУЛЬС»",
        )

        self.session.add(
            Payment(
                order_id=order.id,
                provider=intent.provider,
                external_id=intent.external_id,
                amount=order.total_amount,
                status=PaymentStatus.AWAITING,
            )
        )
        order.payment_status = PaymentStatus.AWAITING
        if order.status is OrderStatus.NEW:
            await self.session.flush()
            order.status = OrderStatus.AWAITING_PAYMENT

        await self.session.commit()
        return intent

    async def apply_webhook(self, raw_body: bytes, signature: str) -> Order | None:
        """Обрабатывает вебхук платёжной системы.

        Защита от двойного зачисления: внешний идентификатор уникален,
        повторный вебхук того же платежа просто возвращает заказ.
        """
        event = await get_provider().verify_webhook(raw_body, signature)
        if not event.signature_valid or not event.external_id:
            raise BadRequestError(
                "Подпись вебхука не совпадает",
                code="invalid_webhook_signature",
            )

        result = await self.session.execute(
            select(Payment).where(Payment.external_id == event.external_id)
        )
        payment = result.scalar_one_or_none()
        if payment is None:
            raise BadRequestError(
                "Платёж не найден",
                code="payment_not_found",
            )

        order = await self._order_of(payment)
        if order is None:
            return None

        provider = get_provider()
        if (
            provider.is_ready_to_capture(event.status)
            and order.payment_status is not PaymentStatus.PAID
        ):
            await self.change_status(order, OrderStatus.PAID)
            payment.status = PaymentStatus.PAID
        else:
            payment.status = PaymentStatus.FAILED if event.status == "failed" else payment.status

        await self.session.commit()
        return order

    async def load_order(self, order_id: uuid.UUID) -> Order:
        """Перечитывает заказ с позициями после изменения статуса."""
        order = await self.session.get(
            Order,
            order_id,
            options=(selectinload(Order.items),),
        )
        if order is None:
            raise NotFoundError("Заказ не найден", code="order_not_found")
        return order

    async def latest_payment(self, order: Order) -> Payment | None:
        """Последняя попытка оплаты заказа."""
        result = await self.session.execute(
            select(Payment)
            .where(Payment.order_id == order.id)
            .order_by(Payment.created_at.desc())
            .limit(1)
        )
        return result.scalar_one_or_none()

    async def _order_of(self, payment: Payment) -> Order | None:
        return await self.session.get(
            Order,
            payment.order_id,
            options=(selectinload(Order.items),),
        )

    # ── Внутреннее ──

    async def cart_items(
        self,
        *,
        user: User | None,
        cart_session: str | None,
    ) -> list[CartItem]:
        """Позиции корзины с товарами, готовые к оформлению."""
        stmt = (
            select(CartItem)
            .join(Product, Product.id == CartItem.product_id)
            .options(selectinload(CartItem.product))
            .order_by(CartItem.created_at)
        )
        if user is not None:
            stmt = stmt.where(CartItem.user_id == user.id)
        elif cart_session:
            stmt = stmt.where(CartItem.user_id.is_(None), CartItem.session_id == cart_session)
        else:
            raise BadRequestError("Корзина не найдена", code="empty_cart")
        return list((await self.session.execute(stmt)).scalars().unique().all())

    async def _clear_cart(self, *, user: User | None, cart_session: str | None) -> None:
        stmt = select(CartItem)
        if user is not None:
            stmt = stmt.where(CartItem.user_id == user.id)
        elif cart_session:
            stmt = stmt.where(CartItem.user_id.is_(None), CartItem.session_id == cart_session)
        for row in (await self.session.execute(stmt)).scalars().all():
            await self.session.delete(row)

    async def _find_by_idempotency(self, key: str, user: User | None) -> Order | None:
        stmt = select(Order).where(Order.idempotency_key == key)
        if user is not None:
            stmt = stmt.where(Order.user_id == user.id)
        order = (await self.session.execute(stmt)).scalar_one_or_none()
        if order is None:
            return None
        return await self.session.get(
            Order,
            order.id,
            options=(selectinload(Order.items),),
        )

    async def _next_order_number(self) -> str:
        """Номер заказа вида PL-20261007-4F2A.

        Читаемый префикс с датой помогает покупателю называть заказ в
        поддержке; случайный хвост исключает совпадения, поэтому
        дополнительной последовательности в базе не нужно.
        """
        today = datetime.now(UTC).strftime("%Y%m%d")
        return f"PL-{today}-{secrets.token_hex(2).upper()}"

    async def _apply_promo_usage(
        self,
        order: Order,
        breakdown: PriceBreakdown,
        user: User | None,
    ) -> None:
        """Учитывает применение промокода: счётчик и история (раздел 6.5)."""
        if not breakdown.promo_code or breakdown.promo_discount <= 0:
            return
        promo = (
            await self.session.execute(
                select(PromoCode).where(PromoCode.code == breakdown.promo_code)
            )
        ).scalar_one_or_none()
        if promo is None:
            return
        promo.used_count += 1
        self.session.add(
            PromoCodeUsage(
                promocode_id=promo.id,
                order_id=order.id,
                user_id=user.id if user else None,
                discount_amount=breakdown.promo_discount,
            )
        )

    async def _order_user(self, order: Order) -> User | None:
        if order.user_id is None:
            return None
        return await self.session.get(User, order.user_id)

    async def _notify(
        self,
        user: User | None,
        notification_type: str,
        title: str,
        body: str,
    ) -> None:
        """Создаёт уведомление в кабинете (раздел 15).

        Гостю уведомление не доставляется: у него нет профиля, а email
        в MVP не отправляется — об этом честно сказано в логе.
        """
        if user is None:
            logger.info("Уведомление гостю (email в MVP не подключён): %s — %s", title, body)
            return
        from app.models.content import Notification
        from app.models.enums import NotificationType

        self.session.add(
            Notification(
                user_id=user.id,
                type=NotificationType(notification_type),
                title=title,
                body=body,
                payload={"order_id": title},
            )
        )
        await self.session.flush()

    @staticmethod
    def status_label(status: OrderStatus) -> str:
        """Подпись статуса — общая для сервисов заказов и кабинета."""
        return order_status_label(status)


# Импорты в конце модуля — чтобы не создавать цикл при импорте схем.
from sqlalchemy import func  # noqa: E402

from app.models.catalog import Product  # noqa: E402


async def release_expired_reservations(session: AsyncSession) -> int:
    """Снимает брони заказов, которые не оплатили в срок.

    Фоновая задача этапа 5: без неё резерв на неоплаченный заказ
    заблокировал бы товар навсегда.
    """
    result = await session.execute(
        select(Order).where(
            Order.status == OrderStatus.AWAITING_PAYMENT,
            Order.reservation_expires_at.is_not(None),
            Order.reservation_expires_at < datetime.now(UTC),
        )
    )
    released = 0
    stock = StockService(session)
    for order in result.scalars().all():
        await stock.release(reserved_map(order.items))
        order.reservation_expires_at = None
        released += 1
    if released:
        await session.commit()
        logger.info("Сняты брони просроченных заказов: %s", released)
    return released


def expiry_delta(hours: int) -> timedelta:
    return timedelta(hours=hours)


assert Decimal is not None
