"""Реестр моделей.

Alembic ``env.py`` импортирует этот модуль: ``Base.metadata`` заполняется при
импорте, и ``--autogenerate`` видит все таблицы. Новую модель достаточно
добавить в импорт ниже — регистрация вручную не нужна.
"""

from __future__ import annotations

from app.db.session import Base
from app.models.catalog import (
    AttributeDef,
    Brand,
    Category,
    Product,
    ProductImage,
    ProductRelation,
    ProductSpec,
)
from app.models.content import (
    AdminAuditLog,
    Banner,
    FaqItem,
    IdempotencyKey,
    Notification,
    Page,
    Setting,
)
from app.models.enums import (
    AttributeDataType,
    DeliveryMethod,
    DiscountType,
    FilterWidget,
    NotificationType,
    OrderStatus,
    PaymentMethod,
    PaymentStatus,
    ProductRelationKind,
    ProductStatus,
    ReviewStatus,
    TokenPurpose,
    UserRole,
)
from app.models.order import (
    CartItem,
    Favorite,
    Order,
    OrderItem,
    Payment,
    PickupPoint,
)
from app.models.review import (
    PromoCode,
    PromoCodeCategory,
    PromoCodeProduct,
    PromoCodeUsage,
    Review,
    ReviewImage,
)
from app.models.user import Address, EmailToken, User, UserSession

__all__ = [
    # База
    "Base",
    # Пользователи
    "Address",
    "EmailToken",
    "User",
    "UserSession",
    # Каталог
    "AttributeDef",
    "Brand",
    "Category",
    "Product",
    "ProductImage",
    "ProductRelation",
    "ProductSpec",
    # Заказы
    "CartItem",
    "Favorite",
    "Order",
    "OrderItem",
    "Payment",
    "PickupPoint",
    # Отзывы и промокоды
    "PromoCode",
    "PromoCodeCategory",
    "PromoCodeProduct",
    "PromoCodeUsage",
    "Review",
    "ReviewImage",
    # Контент и служебное
    "AdminAuditLog",
    "Banner",
    "FaqItem",
    "IdempotencyKey",
    "Notification",
    "Page",
    "Setting",
    # Перечисления
    "AttributeDataType",
    "DeliveryMethod",
    "DiscountType",
    "FilterWidget",
    "NotificationType",
    "OrderStatus",
    "PaymentMethod",
    "PaymentStatus",
    "ProductRelationKind",
    "ProductStatus",
    "ReviewStatus",
    "TokenPurpose",
    "UserRole",
]
