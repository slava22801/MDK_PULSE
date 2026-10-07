"""Схемы корзины (разделы 5.8 и 8.5 ТЗ).

Все итоговые суммы считает backend: раздел 22 ТЗ прямо запрещает
фронтенду определять стоимость заказа и доступное количество.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models.enums import ProductStatus
from app.schemas.catalog import CategoryRef


class CartItemOut(BaseModel):
    """Позиция корзины с пересчитанной под текущие цены суммой.

    ``unit_price`` — актуальная цена товара на момент чтения, а не та,
    по которой его положили в корзину: пользователь должен видеть, что
    товар подешевел или подорожал после добавления.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    product_id: uuid.UUID
    quantity: int

    product_name: str
    product_slug: str
    sku: str
    brand_name: str | None = None
    category: CategoryRef
    image_url: str | None = None
    image_alt: str | None = None

    unit_price: Decimal
    old_price: Decimal | None = None
    discount_percent: int = 0
    line_total: Decimal
    currency: str = "RUB"

    # Что произойдёт при попытке купить: по этому полю интерфейс решает,
    # показывать ли предупреждение о нехватке остатка.
    availability: ProductStatus
    available_quantity: int
    exceeds_stock: bool = False

    added_at: datetime


class CartTotals(BaseModel):
    """Итоги корзины. Считаются на сервере, здесь только результат."""

    items_count: int = 0
    subtotal: Decimal = Decimal("0")
    discount_amount: Decimal = Decimal("0")
    delivery_cost: Decimal = Decimal("0")
    total: Decimal = Decimal("0")
    currency: str = "RUB"


class CartNotice(BaseModel):
    """Сообщение покупателю об ограничении по остатку (раздел 5.8 ТЗ).

    Отдельная сущность, а не ошибка: корзина остаётся пригодной, но
    покупатель видит, сколько на самом деле доступно. ТЗ требует именно
    сообщения «Доступно только N единиц товара», молчаливое урезание
    количества этот текст не заменяет.
    """

    product_id: uuid.UUID
    product_name: str
    requested: int
    available: int
    code: str = "insufficient_stock"
    message: str


class CartOut(BaseModel):
    items: list[CartItemOut] = Field(default_factory=list)
    totals: CartTotals = Field(default_factory=CartTotals)
    # Сколько позиций нельзя купить прямо сейчас — интерфейс подсвечивает
    # их в корзине и предлагает уменьшить количество.
    unavailable_count: int = 0
    notices: list[CartNotice] = Field(default_factory=list)


class AddToCartRequest(BaseModel):
    product_id: uuid.UUID
    quantity: int = Field(default=1, ge=1, le=99)

    @field_validator("quantity")
    @classmethod
    def _reject_zero(cls, value: int) -> int:
        # le=99 уже ограничивает сверху; нижняя граница проверяется явно,
        # чтобы причина отказа была понятна из кода ошибки.
        if value < 1:
            raise ValueError("Количество должно быть не меньше одного")
        return value


class UpdateCartItemRequest(BaseModel):
    quantity: int = Field(ge=1, le=99)


class CartMergeResponse(BaseModel):
    """Результат слияния гостевой корзины с серверной при входе.

    Раздел 5.8: гостевая корзина объединяется с корзиной пользователя.
    Количество суммируется по совпадающим позициям с обрезкой по остатку.
    """

    items: list[CartItemOut] = Field(default_factory=list)
    totals: CartTotals = Field(default_factory=CartTotals)
    merged_positions: int = 0
    removed_for_stock: int = 0
    notices: list[CartNotice] = Field(default_factory=list)
