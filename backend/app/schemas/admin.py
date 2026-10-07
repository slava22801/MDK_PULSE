"""Схемы административной панели (разделы 6 и 8.9–8.10 ТЗ).

Ключевое правило: в админских схемах товара есть ``purchase_price``, а в
публичных (``schemas.catalog``) — нет. Одно и то же поле видно сотруднику и
не видно покупателю.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.models.enums import (
    OrderStatus,
    ProductStatus,
    ReviewStatus,
    UserRole,
)
from app.schemas.order import OrderItemOut, OrderSummary

# ── Товары ──


class AdminProductListItem(BaseModel):
    """Строка списка товаров в админке (раздел 6.1)."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    slug: str
    name: str
    sku: str
    price: Decimal
    old_price: Decimal | None
    purchase_price: Decimal | None
    stock_quantity: int
    reserved_quantity: int
    status: ProductStatus
    is_active: bool
    category_id: uuid.UUID
    brand_id: uuid.UUID | None
    rating_avg: Decimal
    rating_count: int
    updated_at: datetime

    @property
    def available_quantity(self) -> int:
        return max(0, self.stock_quantity - self.reserved_quantity)


class AdminProductDetail(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    slug: str
    name: str
    sku: str
    model: str | None
    category_id: uuid.UUID
    brand_id: uuid.UUID | None

    short_description: str | None
    description: str | None

    price: Decimal
    old_price: Decimal | None
    purchase_price: Decimal | None
    currency: str = "RUB"

    stock_quantity: int
    reserved_quantity: int
    min_stock: int

    status: ProductStatus
    is_active: bool
    warranty_months: int

    weight: Decimal | None
    width: Decimal | None
    height: Decimal | None
    length: Decimal | None

    rating_avg: Decimal
    rating_count: int
    sales_count: int

    seo_title: str | None
    seo_description: str | None

    created_at: datetime
    updated_at: datetime


class ProductCreate(BaseModel):
    """Создание товара (раздел 6.1)."""

    name: str = Field(min_length=2, max_length=300)
    slug: str | None = Field(default=None, max_length=300)
    sku: str = Field(min_length=1, max_length=64)
    model: str | None = Field(default=None, max_length=150)
    category_id: uuid.UUID
    brand_id: uuid.UUID | None = None

    short_description: str | None = Field(default=None, max_length=500)
    description: str | None = None

    price: Decimal = Field(gt=0)
    old_price: Decimal | None = Field(default=None, gt=0)
    purchase_price: Decimal | None = Field(default=None, gt=0)

    stock_quantity: int = Field(default=0, ge=0)
    min_stock: int = Field(default=0, ge=0)
    status: ProductStatus = ProductStatus.IN_STOCK
    is_active: bool = True
    warranty_months: int = Field(default=12, ge=0, le=600)

    weight: Decimal | None = None
    width: Decimal | None = None
    height: Decimal | None = None
    length: Decimal | None = None

    seo_title: str | None = Field(default=None, max_length=300)
    seo_description: str | None = Field(default=None, max_length=500)

    specs: dict[str, str] = Field(
        default_factory=dict,
        description="Характеристики в виде {ключ: значение}",
    )
    image_urls: list[str] = Field(default_factory=list)
    compatible_product_ids: list[uuid.UUID] = Field(default_factory=list)

    @field_validator("old_price")
    @classmethod
    def _old_price_must_be_higher(cls, value: Decimal | None, info) -> Decimal | None:
        """Старая цена выше текущей — иначе скидка получится отрицательной."""
        price = info.data.get("price")
        if value is not None and price is not None and value <= price:
            raise ValueError("Старая цена должна быть выше текущей")
        return value


class ProductUpdate(BaseModel):
    """Частичное обновление товара.

    Отдельная схема, а не переиспользование ProductCreate: администратор
    правит цену у одного товара и не обязан заново присылать все поля.
    """

    name: str | None = Field(default=None, min_length=2, max_length=300)
    slug: str | None = Field(default=None, max_length=300)
    sku: str | None = Field(default=None, max_length=64)
    model: str | None = None
    category_id: uuid.UUID | None = None
    brand_id: uuid.UUID | None = None
    short_description: str | None = None
    description: str | None = None
    price: Decimal | None = Field(default=None, gt=0)
    old_price: Decimal | None = Field(default=None, gt=0)
    purchase_price: Decimal | None = Field(default=None, gt=0)
    stock_quantity: int | None = Field(default=None, ge=0)
    min_stock: int | None = Field(default=None, ge=0)
    status: ProductStatus | None = None
    is_active: bool | None = None
    warranty_months: int | None = Field(default=None, ge=0, le=600)
    weight: Decimal | None = None
    width: Decimal | None = None
    height: Decimal | None = None
    length: Decimal | None = None
    seo_title: str | None = None
    seo_description: str | None = None
    specs: dict[str, str] | None = None
    image_urls: list[str] | None = None
    compatible_product_ids: list[uuid.UUID] | None = None


class StockAdjust(BaseModel):
    """Изменение остатка (раздел 6.1)."""

    delta: int = Field(
        description="Изменение остатка: положительное — приход, отрицательное — списание"
    )
    reason: str | None = Field(default=None, max_length=200)


# ── Заказы ──


class AdminOrderListItem(OrderSummary):
    model_config = ConfigDict(from_attributes=True)

    customer_full_name: str = ""
    customer_email: EmailStr | None = None
    customer_phone: str | None = None
    comment: str | None = None


class AdminOrderDetail(OrderSummary):
    items: list[OrderItemOut] = Field(default_factory=list)
    customer_first_name: str = ""
    customer_last_name: str = ""
    customer_email: EmailStr | None = None
    customer_phone: str | None = None
    delivery_address: dict | None = None
    pickup_point_id: str | None = None
    comment: str | None = None
    manager_comment: str | None = None
    promo_code: str | None = None
    can_cancel: bool = False


class AdminOrderUpdate(BaseModel):
    """Изменение заказа администратором (раздел 6.3)."""

    status: OrderStatus | None = None
    tracking_number: str | None = Field(default=None, max_length=100)
    manager_comment: str | None = Field(default=None, max_length=1000)


class StatusChangeResponse(BaseModel):
    order: AdminOrderDetail
    message: str


# ── Пользователи ──


class AdminUserListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: EmailStr
    first_name: str
    last_name: str
    phone: str | None
    role: UserRole
    is_active: bool
    email_verified: bool
    blocked_at: datetime | None
    created_at: datetime
    last_login_at: datetime | None
    orders_count: int = 0


class AdminUserUpdate(BaseModel):
    """Изменение прав пользователя (раздел 6.4)."""

    role: UserRole | None = None
    is_blocked: bool | None = Field(
        default=None,
        description="True — заблокировать, False — разблокировать",
    )
    password: str | None = Field(
        default=None,
        min_length=8,
        max_length=128,
        description="Новый пароль; если не передан — пароль не меняется",
    )


# ── Промокоды ──


class PromoCodeCreate(BaseModel):
    code: str = Field(min_length=3, max_length=50)
    description: str | None = Field(default=None, max_length=300)
    discount_type: str = Field(pattern="^(fixed|percent|free_delivery)$")
    discount_value: Decimal = Field(default=Decimal("0"), ge=0)

    min_order_amount: Decimal = Field(default=Decimal("0"), ge=0)
    max_discount_amount: Decimal | None = Field(default=None, ge=0)

    usage_limit: int | None = Field(default=None, ge=1)
    usage_limit_per_user: int | None = Field(default=None, ge=1)

    valid_from: datetime
    valid_to: datetime

    category_ids: list[uuid.UUID] = Field(default_factory=list)
    excluded_product_ids: list[uuid.UUID] = Field(default_factory=list)
    is_active: bool = True

    @field_validator("code")
    @classmethod
    def _uppercase(cls, value: str) -> str:
        return value.strip().upper()

    @field_validator("valid_to")
    @classmethod
    def _check_period(cls, value: datetime, info) -> datetime:
        valid_from = info.data.get("valid_from")
        if valid_from is not None and value <= valid_from:
            raise ValueError("Дата окончания должна быть позже даты начала")
        return value


class PromoCodeUpdate(BaseModel):
    description: str | None = None
    discount_type: str | None = Field(default=None, pattern="^(fixed|percent|free_delivery)$")
    discount_value: Decimal | None = Field(default=None, ge=0)
    min_order_amount: Decimal | None = Field(default=None, ge=0)
    max_discount_amount: Decimal | None = Field(default=None, ge=0)
    usage_limit: int | None = Field(default=None, ge=1)
    usage_limit_per_user: int | None = Field(default=None, ge=1)
    valid_from: datetime | None = None
    valid_to: datetime | None = None
    is_active: bool | None = None


class PromoCodeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    code: str
    description: str | None
    discount_type: str
    discount_value: Decimal
    min_order_amount: Decimal
    max_discount_amount: Decimal | None
    usage_limit: int | None
    used_count: int
    usage_limit_per_user: int | None
    valid_from: datetime
    valid_to: datetime
    is_active: bool


class PromoCheckRequest(BaseModel):
    code: str
    total: Decimal = Field(default=Decimal("0"), ge=0)


class PromoCheckResponse(BaseModel):
    valid: bool
    message: str
    discount_amount: Decimal = Decimal("0")
    promo_code: str | None = None


# ── Категории и бренды ──


class CategoryCreate(BaseModel):
    name: str = Field(min_length=2, max_length=150)
    slug: str | None = Field(default=None, max_length=150)
    parent_id: uuid.UUID | None = None
    description: str | None = None
    image_url: str | None = None
    sort_order: int = 0
    is_active: bool = True


class CategoryUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=150)
    parent_id: uuid.UUID | None = None
    description: str | None = None
    image_url: str | None = None
    sort_order: int | None = None
    is_active: bool | None = None


class BrandCreate(BaseModel):
    name: str = Field(min_length=2, max_length=150)
    slug: str | None = Field(default=None, max_length=150)
    description: str | None = None
    logo_url: str | None = None
    is_active: bool = True


class BrandUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=150)
    description: str | None = None
    logo_url: str | None = None
    is_active: bool | None = None


# ── Импорт ──


class ImportRowError(BaseModel):
    """Ошибка одной строки импорта (раздел 14)."""

    row_number: int
    column: str | None = None
    message: str


class ImportReport(BaseModel):
    """Итог импорта: что загружено и что не удалось."""

    total_rows: int = 0
    created: int = 0
    updated: int = 0
    skipped: int = 0
    errors: list[ImportRowError] = Field(default_factory=list)
    message: str = ""

    @property
    def has_errors(self) -> bool:
        return bool(self.errors)


class StatisticsResponse(BaseModel):
    """Сводка по магазину (раздел 6.4)."""

    revenue_total: Decimal
    revenue_period: Decimal
    orders_total: int
    orders_pending: int
    orders_completed: int
    orders_cancelled: int
    average_order_value: Decimal
    customers_total: int
    new_customers_period: int
    products_total: int
    products_out_of_stock: int
    products_low_stock: int
    reviews_pending: int
    best_sellers: list[dict] = Field(default_factory=list)
    low_stock_items: list[dict] = Field(default_factory=list)
    sales_by_day: list[dict] = Field(default_factory=list)
    period_days: int = 30


# ── Отзывы ──


class ReviewOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    product_id: uuid.UUID
    product_name: str | None = None
    user_email: EmailStr | None = None
    rating: int
    title: str
    text: str
    status: ReviewStatus
    is_verified_purchase: bool
    created_at: datetime


class ReviewUpdate(BaseModel):
    status: ReviewStatus
    comment: str | None = Field(default=None, max_length=300)


# ── Контент ──


class BannerCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    subtitle: str | None = Field(default=None, max_length=300)
    image_url: str | None = None
    link_url: str | None = None
    button_text: str | None = Field(default=None, max_length=50)
    sort_order: int = 0
    is_active: bool = True


class FaqItemCreate(BaseModel):
    question: str = Field(min_length=2, max_length=300)
    answer: str = Field(min_length=2)
    category: str | None = Field(default=None, max_length=100)
    sort_order: int = 0
    is_published: bool = True


class PageUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    content: str | None = None
    seo_title: str | None = Field(default=None, max_length=300)
    seo_description: str | None = Field(default=None, max_length=500)
    is_published: bool | None = None


class AdminListResponse(BaseModel):
    """Универсальная постраничная выдача для админских списков."""

    items: list = Field(default_factory=list)
    total: int = 0
    page: int = 1
    limit: int = 25
    pages: int = 0
