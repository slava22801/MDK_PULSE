"""Схемы избранного и сравнения (разделы 5.5 и 5.6 ТЗ)."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field

from app.schemas.catalog import CategoryRef, ProductCard


class FavoriteItem(ProductCard):
    """Товар в избранном.

    Дополнительно отдаём, что изменилось с момента добавления: раздел 5.6
    требует показывать покупателю изменение цены и появление товара в наличии.
    """

    price_changed: bool = False
    price_delta: Decimal | None = None
    back_in_stock: bool = False
    added_at: datetime


class FavoriteListResponse(BaseModel):
    items: list[FavoriteItem] = Field(default_factory=list)
    total: int = 0
    # Сколько товаров из избранного требуют внимания (цена изменилась или
    # товар снова в наличии) — для счётчика в интерфейсе.
    attention_count: int = 0


class FavoriteStateResponse(BaseModel):
    """Ответ на добавление в избранное — нужен кнопке на карточке."""

    product_id: uuid.UUID
    is_favorite: bool
    total: int


class CompareRequest(BaseModel):
    """Запрос на сравнение: список идентификаторов товаров."""

    product_ids: list[uuid.UUID] = Field(min_length=1)


class CompareProduct(ProductCard):
    """Товар в таблице сравнения плюс его характеристики."""

    specs: dict[str, str] = Field(default_factory=dict)
    # Подсвеченные строки: интерфейс выделяет то, чем товары отличаются.
    differs: list[str] = Field(default_factory=list)


class CompareAttributeRow(BaseModel):
    """Одна строка таблицы сравнения."""

    key: str
    name: str
    unit: str | None = None
    # Значение по каждому товару в том же порядке, что и products.
    values: list[str | None] = Field(default_factory=list)
    is_different: bool = False


class CompareResponse(BaseModel):
    """Таблица сравнения (раздел 5.5 ТЗ).

    Товары всегда одной категории: сравнивать процессор с монитором
    бессмысленно, а ТЗ это прямо запрещает.
    """

    category: CategoryRef
    products: list[CompareProduct] = Field(default_factory=list)
    attributes: list[CompareAttributeRow] = Field(default_factory=list)
    identical_count: int = 0
    different_count: int = 0
