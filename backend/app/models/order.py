"""Заказы, позиции, корзина, избранное (разделы 5.8–5.11 ТЗ)."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.catalog import Product
from app.models.enums import (
    DeliveryMethod,
    OrderStatus,
    PaymentMethod,
    PaymentStatus,
)
from app.models.mixins import Base, TimestampsMixin, UUIDPrimaryKeyMixin, pg_enum

MONEY = Numeric(12, 2)


class Order(UUIDPrimaryKeyMixin, TimestampsMixin, Base):
    """Раздел 7.7 ТЗ.

    Суммы фиксируются на момент оформления: цены в позициях не пересчитываются
    при изменении товара (критерий приёмки №25).
    """

    __tablename__ = "orders"
    __table_args__ = (
        UniqueConstraint("order_number", name="uq_orders_order_number"),
        Index("ix_orders_user_created", "user_id", "created_at"),
        Index("ix_orders_status_created", "status", "created_at"),
        # Гостевой заказ создаётся без user_id — курьеру нужен телефон,
        # чтобы связаться с покупателем.
        Index("ix_orders_phone", "customer_phone"),
    )

    order_number: Mapped[str] = mapped_column(String(32), nullable=False)
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        index=True,
        nullable=True,
    )

    status: Mapped[OrderStatus] = mapped_column(
        pg_enum(OrderStatus, "order_status"),
        default=OrderStatus.NEW,
        index=True,
        nullable=False,
    )
    payment_status: Mapped[PaymentStatus] = mapped_column(
        pg_enum(PaymentStatus, "payment_status"),
        default=PaymentStatus.PENDING,
        nullable=False,
    )
    payment_method: Mapped[PaymentMethod] = mapped_column(
        pg_enum(PaymentMethod, "payment_method"),
        default=PaymentMethod.CASH_ON_DELIVERY,
        nullable=False,
    )
    delivery_method: Mapped[DeliveryMethod] = mapped_column(
        pg_enum(DeliveryMethod, "delivery_method"),
        default=DeliveryMethod.COURIER,
        nullable=False,
    )

    # ── Данные покупателя, зафиксированные на момент заказа ──
    customer_first_name: Mapped[str] = mapped_column(String(100), nullable=False)
    customer_last_name: Mapped[str] = mapped_column(String(100), nullable=False)
    customer_email: Mapped[str] = mapped_column(String(320), index=True, nullable=False)
    customer_phone: Mapped[str] = mapped_column(String(32), nullable=False)

    # ── Деньги ──
    subtotal: Mapped[Decimal] = mapped_column(MONEY, default=0, nullable=False)
    discount_amount: Mapped[Decimal] = mapped_column(MONEY, default=0, nullable=False)
    delivery_cost: Mapped[Decimal] = mapped_column(MONEY, default=0, nullable=False)
    total_amount: Mapped[Decimal] = mapped_column(MONEY, default=0, nullable=False)
    promo_code: Mapped[str | None] = mapped_column(String(50), nullable=True)
    currency: Mapped[str] = mapped_column(String(3), default="RUB", nullable=False)

    # ── Доставка ──
    delivery_address: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    pickup_point_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("pickup_points.id", ondelete="SET NULL"),
        nullable=True,
    )
    tracking_number: Mapped[str | None] = mapped_column(String(100), nullable=True)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    manager_comment: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Ключ идемпотентности: защита от двойного оформления при перезагрузке
    # страницы или повторном клике (раздел 10 ТЗ).
    idempotency_key: Mapped[str | None] = mapped_column(
        String(64),
        unique=True,
        nullable=True,
    )
    # Срок жизни резерва: просроченные брони возвращаются в остаток.
    reservation_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    items: Mapped[list[OrderItem]] = relationship(
        back_populates="order",
        cascade="all, delete-orphan",
        lazy="selectin",
    )

    def __repr__(self) -> str:
        return f"<Order {self.order_number} status={self.status.value} total={self.total_amount}>"


class OrderItem(UUIDPrimaryKeyMixin, Base):
    """Раздел 7.8 ТЗ: состав заказа.

    Название, артикул и цена копируются сюда намеренно — правка карточки товара
    не должна менять уже оформленные заказы (раздел 7.8, критерий №25).
    """

    __tablename__ = "order_items"
    __table_args__ = (Index("ix_order_items_order", "order_id"),)

    order_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("orders.id", ondelete="CASCADE"),
        nullable=False,
    )
    product_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("products.id", ondelete="SET NULL"),
        nullable=True,
    )
    product_name: Mapped[str] = mapped_column(String(300), nullable=False)
    sku: Mapped[str] = mapped_column(String(64), nullable=False)
    # Значения характеристик на момент заказа — для печатной формы и возврата.
    specs_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    price: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    total_price: Mapped[Decimal] = mapped_column(MONEY, nullable=False)

    order: Mapped[Order] = relationship(back_populates="items")


class CartItem(UUIDPrimaryKeyMixin, TimestampsMixin, Base):
    """Раздел 7.9 ТЗ: корзина.

    Двойное владение — ``user_id`` у авторизованных и ``session_id`` у гостя.
    Гостевая корзина живёт по идентификатору сессии из cookie; при входе
    она сливается с серверной корзиной пользователя (раздел 5.8 ТЗ).
    """

    __tablename__ = "cart_items"
    __table_args__ = (
        UniqueConstraint("user_id", "product_id", name="uq_cart_items_user_product"),
        UniqueConstraint("session_id", "product_id", name="uq_cart_items_session_product"),
        Index("ix_cart_items_user", "user_id"),
        Index("ix_cart_items_session", "session_id"),
    )

    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=True,
    )
    session_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    product_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"),
        nullable=False,
    )
    quantity: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    # joined, а не selectin: позиция корзины всегда читается вместе со своим
    # товаром, иначе на каждый чих делался бы отдельный запрос на товар.
    product: Mapped[Product] = relationship(lazy="joined")


class Favorite(UUIDPrimaryKeyMixin, Base):
    """Избранное.

    ``price_at_add`` — цена на момент добавления. Раздел 5.6 ТЗ требует
    показывать покупателю изменение цены; без сохранённой цены определить
    изменение невозможно, а «цена скидки» на товаре меняется вместе с
    акцией. В модели 7.10 ТЗ этого поля нет, но требование важнее.
    """

    __tablename__ = "favorites"
    __table_args__ = (
        UniqueConstraint("user_id", "product_id", name="uq_favorites_user_product"),
        Index("ix_favorites_user", "user_id"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    product_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"),
        nullable=False,
    )
    price_at_add: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )


class Payment(UUIDPrimaryKeyMixin, TimestampsMixin, Base):
    """Попытки оплаты.

    Отдельная от заказа таблица нужна для раздела 10 ТЗ: вебхук платёжной
    системы приходит повторно и не должен повторно списывать деньги.
    Поле external_id уникально — это и есть защита от двойного зачисления.
    """

    __tablename__ = "payments"
    __table_args__ = (
        Index("ix_payments_order", "order_id"),
        Index("ix_payments_external", "provider", "external_id"),
    )

    order_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("orders.id", ondelete="CASCADE"),
        nullable=False,
    )
    provider: Mapped[str] = mapped_column(String(30), nullable=False)
    external_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    status: Mapped[PaymentStatus] = mapped_column(
        pg_enum(PaymentStatus, "payment_record_status"),
        default=PaymentStatus.PENDING,
        nullable=False,
    )
    payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class PickupPoint(UUIDPrimaryKeyMixin, TimestampsMixin, Base):
    """Пункты выдачи (раздел 5.9 ТЗ)."""

    __tablename__ = "pickup_points"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    address: Mapped[str] = mapped_column(String(300), nullable=False)
    city: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    phone: Mapped[str | None] = mapped_column(String(32), nullable=True)
    working_hours: Mapped[str | None] = mapped_column(String(200), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
