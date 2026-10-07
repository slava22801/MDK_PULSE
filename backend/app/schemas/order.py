"""Схемы заказов (разделы 5.9 и 8.6 ТЗ)."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

from app.models.enums import (
    DeliveryMethod,
    OrderStatus,
    PaymentMethod,
    PaymentStatus,
)


class DeliveryAddress(BaseModel):
    """Адрес одной строкой — так его проще разбирать курьеру."""

    city: str = Field(min_length=2, max_length=100)
    street: str = Field(min_length=2, max_length=255)
    building: str = Field(min_length=1, max_length=20)
    apartment: str | None = Field(default=None, max_length=20)
    postal_code: str | None = Field(default=None, max_length=16)
    comment: str | None = None

    def as_line(self) -> str:
        parts = [self.city, self.street, self.building]
        if self.apartment:
            parts.append(f"кв. {self.apartment}")
        if self.postal_code:
            parts.append(self.postal_code)
        return ", ".join(parts)


class OrderCreate(BaseModel):
    """Оформление заказа (шаг 6–7 раздела 5.9).

    Цены сюда не входят намеренно: раздел 22 ТЗ запрещает доверять
    стоимости с клиента, всё считает ``services.pricing``.
    """

    customer_first_name: str = Field(min_length=2, max_length=100)
    customer_last_name: str = Field(min_length=2, max_length=100)
    customer_email: EmailStr
    customer_phone: str = Field(min_length=6, max_length=32)

    delivery_method: DeliveryMethod = DeliveryMethod.COURIER
    payment_method: PaymentMethod = PaymentMethod.CASH_ON_DELIVERY

    delivery_address: DeliveryAddress | None = None
    pickup_point_id: uuid.UUID | None = None
    comment: str | None = Field(default=None, max_length=1000)
    promo_code: str | None = Field(default=None, max_length=50)

    @field_validator("customer_phone")
    @classmethod
    def _normalize_phone(cls, value: str) -> str:
        digits = "".join(ch for ch in value if ch.isdigit())
        if not 10 <= len(digits) <= 15:
            raise ValueError("Телефон должен содержать от 10 до 15 цифр")
        return f"+{digits}"

    @model_validator(mode="after")
    def _check_address(self) -> OrderCreate:
        """Адрес обязателен для доставки и запрещён для самовывоза."""
        if self.delivery_method in {DeliveryMethod.COURIER, DeliveryMethod.TRANSPORT_COMPANY}:
            if self.delivery_address is None:
                raise ValueError("Для доставки курьером нужен адрес")
        if self.delivery_method is DeliveryMethod.PICKUP_POINT and self.pickup_point_id is None:
            raise ValueError("Для пункта выдачи нужно выбрать пункт")
        return self


class OrderItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    product_id: uuid.UUID | None
    product_name: str
    sku: str
    quantity: int
    price: Decimal
    total_price: Decimal


class OrderSummary(BaseModel):
    """Заказ в списке — без полного состава (раздел 5.11)."""

    model_config = ConfigDict(from_attributes=True)

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
    tracking_number: str | None = None
    created_at: datetime
    # Человеческие подписи статусов отдаём готовыми: подписи должны
    # совпадать с админкой и письмами, а не собираться в интерфейсе.
    status_label: str = ""


class OrderOut(OrderSummary):
    items: list[OrderItemOut] = Field(default_factory=list)
    promo_code: str | None = None
    currency: str = "RUB"
    customer_first_name: str = ""
    customer_last_name: str = ""
    customer_email: EmailStr | None = None
    customer_phone: str | None = None
    delivery_address: dict | None = None
    comment: str | None = None
    manager_comment: str | None = None
    can_cancel: bool = False


class OrderListResponse(BaseModel):
    items: list[OrderSummary] = Field(default_factory=list)
    total: int = 0
    page: int = 1
    limit: int = 10
    pages: int = 0


class CheckoutPreviewRequest(BaseModel):
    """Предварительный расчёт из корзины — шаг 1 раздела 5.9.

    Отдельный эндпоинт нужен, чтобы показать покупателю итог до ввода
    данных и оформления: цена зависит от способа доставки и промокода.
    """

    promo_code: str | None = Field(default=None, max_length=50)
    delivery_method: DeliveryMethod = DeliveryMethod.COURIER
    payment_method: PaymentMethod = PaymentMethod.CASH_ON_DELIVERY


class CheckoutPreview(BaseModel):
    items_count: int = 0
    items: list[OrderItemOut] = Field(default_factory=list)
    subtotal: Decimal
    discount_amount: Decimal
    delivery_cost: Decimal
    total: Decimal
    currency: str = "RUB"
    promo_code: str | None = None
    notes: list[str] = Field(default_factory=list)
    # Сколько единиц товара не хватает: оформление будет отклонено (5.8).
    unavailable: list[str] = Field(default_factory=list)


class PaymentStartResponse(BaseModel):
    provider: str
    external_id: str
    amount: Decimal
    status: str
    redirect_url: str | None = None
    confirmation_token: str | None = None


class PaymentConfirmRequest(BaseModel):
    token: str = Field(min_length=10, max_length=512)


class MessageResponse(BaseModel):
    message: str


class StatusChangeRequest(BaseModel):
    """Смена статуса заказа администратором (раздел 6.3)."""

    status: OrderStatus
    comment: str | None = Field(default=None, max_length=1000)
