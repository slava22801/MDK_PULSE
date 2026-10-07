"""Перечисления предметной области.

Все значения enum хранятся в PostgreSQL как нативные типы ENUM, а не как
строки в TEXT: сравнение по enum быстрее и не требует CHECK-констрейнта
в приложении. Одноимённый Python-enum остаётся источником истины — при
изменении набора значений нужна миграция.
"""

from __future__ import annotations

import enum


class StrEnum(enum.StrEnum):
    """Строковой enum, совместимый с Python 3.11+.

    Наследуется от встроенного ``enum.StrEnum``: значение сериализуется
    как есть (не как ``StrEnum.CUSTOMER``), а Pydantic и SQLAlchemy видят
    обычную строку.
    """

    def __str__(self) -> str:
        return str(self.value)


class UserRole(StrEnum):
    """Раздел 3 ТЗ: гость → покупатель → менеджер → администратор."""

    CUSTOMER = "customer"
    MANAGER = "manager"
    ADMIN = "admin"

    @property
    def is_staff(self) -> bool:
        return self in (UserRole.MANAGER, UserRole.ADMIN)


class ProductStatus(StrEnum):
    """Раздел 5.4 ТЗ: состояния товара."""

    IN_STOCK = "in_stock"
    LOW_STOCK = "low_stock"
    ON_ORDER = "on_order"
    EXPECTED = "expected"
    OUT_OF_STOCK = "out_of_stock"
    DISCONTINUED = "discontinued"

    @property
    def is_purchasable(self) -> bool:
        """В заказ попадают только товары, которые физически можно отгрузить."""
        return self in (ProductStatus.IN_STOCK, ProductStatus.LOW_STOCK)


class OrderStatus(StrEnum):
    """Раздел 5.10 ТЗ: 11 статусов заказа."""

    NEW = "new"
    CONFIRMED = "confirmed"
    AWAITING_PAYMENT = "awaiting_payment"
    PAID = "paid"
    ASSEMBLING = "assembling"
    SHIPPED = "shipped"
    READY_FOR_PICKUP = "ready_for_pickup"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    RETURNED = "return_requested"
    REFUNDED = "refunded"

    @property
    def is_final(self) -> bool:
        """Финальные статусы: заказ больше не меняется, резерв не действует."""
        return self in (
            OrderStatus.COMPLETED,
            OrderStatus.CANCELLED,
            OrderStatus.REFUNDED,
        )

    @property
    def is_cancellable_by_customer(self) -> bool:
        """Раздел 5.11: клиент отменяет заказ до начала сборки."""
        return self in (
            OrderStatus.NEW,
            OrderStatus.CONFIRMED,
            OrderStatus.AWAITING_PAYMENT,
            OrderStatus.PAID,
        )


class PaymentStatus(StrEnum):
    PENDING = "pending"
    AWAITING = "awaiting"
    PAID = "paid"
    FAILED = "failed"
    REFUNDED = "refunded"
    CANCELLED = "cancelled"


class PaymentMethod(StrEnum):
    """Раздел 5.9 ТЗ. MVP использует CASH_ON_DELIVERY (раздел 16)."""

    CARD = "card"
    ONLINE = "online"
    CASH_ON_DELIVERY = "cash_on_delivery"
    INVOICE = "invoice"


class DeliveryMethod(StrEnum):
    """Раздел 5.9 ТЗ. MVP использует COURIER (раздел 16)."""

    COURIER = "courier"
    PICKUP = "pickup"
    PICKUP_POINT = "pickup_point"
    TRANSPORT_COMPANY = "transport_company"


class ReviewStatus(StrEnum):
    """Раздел 5.12 ТЗ: модерация отзывов."""

    PENDING = "pending"
    PUBLISHED = "published"
    REJECTED = "rejected"
    HIDDEN = "hidden"


class DiscountType(StrEnum):
    """Раздел 6.5 ТЗ."""

    FIXED = "fixed"
    PERCENT = "percent"
    FREE_DELIVERY = "free_delivery"


class AttributeDataType(StrEnum):
    """Тип значения характеристики — определяет виджет фильтра."""

    TEXT = "text"
    NUMBER = "number"
    BOOL = "bool"
    ENUM = "enum"


class FilterWidget(StrEnum):
    """Как отрисовывать фильтр во фронтенде."""

    RANGE = "range"
    CHECKBOX = "checkbox"
    SELECT = "select"
    SLIDER = "slider"


class ProductRelationKind(StrEnum):
    COMPATIBLE = "compatible"
    SIMILAR = "similar"
    ACCESSORY = "accessory"


class TokenPurpose(StrEnum):
    """Раздел 5.7 ТЗ: подтверждение email и восстановление пароля."""

    EMAIL_VERIFICATION = "email_verification"
    PASSWORD_RESET = "password_reset"


class NotificationType(StrEnum):
    """Раздел 15 ТЗ."""

    ORDER_CREATED = "order_created"
    ORDER_STATUS_CHANGED = "order_status_changed"
    PAYMENT_SUCCESS = "payment_success"
    ORDER_CANCELLED = "order_cancelled"
    EMAIL_VERIFIED = "email_verified"
    PASSWORD_RESET = "password_reset"
    PRODUCT_BACK_IN_STOCK = "product_back_in_stock"
    FAVORITE_PRICE_CHANGED = "favorite_price_changed"
