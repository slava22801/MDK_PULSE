"""Личный кабинет (раздел 5.11 ТЗ).

Профиль, адреса доставки и история заказов. Отзывы и настройки уведомлений
появятся вместе с соответствующими доменами (этапы 5 и 6), а не здесь.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.models.enums import (
    DeliveryMethod,
    OrderStatus,
    PaymentMethod,
    PaymentStatus,
)


class ProfileUpdate(BaseModel):
    """Изменение профиля. Email здесь не меняется: смена требует
    повторного подтверждения и отдельного сценария (раздел 5.7)."""

    first_name: str | None = Field(default=None, min_length=2, max_length=100)
    last_name: str | None = Field(default=None, min_length=2, max_length=100)
    phone: str | None = Field(default=None, min_length=6, max_length=32)

    @field_validator("phone")
    @classmethod
    def _normalize(cls, value: str | None) -> str | None:
        if value is None:
            return None
        digits = "".join(ch for ch in value if ch.isdigit())
        if not 10 <= len(digits) <= 15:
            raise ValueError("Телефон должен содержать от 10 до 15 цифр")
        return f"+{digits}"


class ProfileResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: EmailStr
    first_name: str
    last_name: str
    phone: str | None
    role: str
    email_verified: bool
    created_at: datetime


class AddressCreate(BaseModel):
    label: str = Field(default="Домой", max_length=50)
    recipient_name: str = Field(min_length=2, max_length=200)
    phone: str = Field(min_length=6, max_length=32)
    city: str = Field(min_length=2, max_length=100)
    street: str = Field(min_length=2, max_length=255)
    building: str = Field(min_length=1, max_length=20)
    apartment: str | None = Field(default=None, max_length=20)
    postal_code: str | None = Field(default=None, max_length=16)
    country: str = Field(default="Россия", max_length=100)
    comment: str | None = None
    is_default: bool = False

    @field_validator("phone")
    @classmethod
    def _normalize(cls, value: str) -> str:
        digits = "".join(ch for ch in value if ch.isdigit())
        if not 10 <= len(digits) <= 15:
            raise ValueError("Телефон должен содержать от 10 до 15 цифр")
        return f"+{digits}"


class AddressUpdate(BaseModel):
    label: str | None = Field(default=None, max_length=50)
    recipient_name: str | None = Field(default=None, min_length=2, max_length=200)
    phone: str | None = Field(default=None, min_length=6, max_length=32)
    city: str | None = Field(default=None, min_length=2, max_length=100)
    street: str | None = Field(default=None, min_length=2, max_length=255)
    building: str | None = Field(default=None, min_length=1, max_length=20)
    apartment: str | None = Field(default=None, max_length=20)
    postal_code: str | None = Field(default=None, max_length=16)
    country: str | None = Field(default=None, max_length=100)
    comment: str | None = None
    is_default: bool | None = None


class AddressOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    label: str
    recipient_name: str
    phone: str
    city: str
    street: str
    building: str
    apartment: str | None
    postal_code: str | None
    country: str
    comment: str | None
    is_default: bool
    created_at: datetime


# Сводка заказа и список в истории берутся из schemas.order: там же живёт
# и OrderOut с составом позиций. Дублировать класс здесь было ошибкой —
# две копии одной схемы разъехались: в кабинете пропала подпись статуса.
class OrderSummary(BaseModel):
    """Заказ в списке истории — без полного состава (раздел 5.11).

    Полная карточка с позициями отдаётся отдельным эндпоинтом: список
    истории грузится одним запросом и не должен тянуть все позиции.
    """

    id: uuid.UUID
    order_number: str
    status: OrderStatus
    payment_status: PaymentStatus
    payment_method: PaymentMethod
    delivery_method: DeliveryMethod
    subtotal: Decimal
    discount_amount: Decimal
    delivery_cost: Decimal
    total_amount: Decimal
    items_count: int = 0
    tracking_number: str | None
    created_at: datetime
    status_label: str = ""


class OrderItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    product_name: str
    sku: str
    quantity: int
    price: Decimal
    total_price: Decimal


class OrderListResponse(BaseModel):
    items: list[OrderSummary] = Field(default_factory=list)
    total: int = 0
    page: int = 1
    limit: int = 10
    pages: int = 0


class OrderDetailResponse(BaseModel):
    order: OrderSummary
    items: list[OrderItemOut] = Field(default_factory=list)
    delivery_address: dict | None = None
    comment: str | None = None
    manager_comment: str | None = None
    can_cancel: bool = False
