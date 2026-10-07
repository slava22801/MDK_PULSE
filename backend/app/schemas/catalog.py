"""Pydantic-схемы каталога (разделы 5.2–5.4 и 8.2–8.4 ТЗ).

Все денежные величины сериализуются строками: на бэкенде это ``Decimal``,
во float его превращать нельзя — 0.1 + 0.2 не равно 0.3, и покупатель увидел бы
неверную сумму.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import ProductStatus


class BrandRef(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    slug: str
    logo_url: str | None = None


class CategoryRef(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    slug: str
    level: int
    parent_id: uuid.UUID | None = None
    image_url: str | None = None
    children: list[CategoryRef] = Field(default_factory=list)


class BrandOut(BrandRef):
    description: str | None = None


class ProductImageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    image_url: str
    alt: str | None = None
    sort_order: int
    is_main: bool


class ProductSpecOut(BaseModel):
    """Одна характеристика в том виде, в каком её показывает карточка."""

    key: str
    name: str
    value: str
    unit: str | None = None
    data_type: str
    sort_order: int = 0


class ProductCard(BaseModel):
    """Карточка товара для списка и сетки каталога.

    ``purchase_price`` здесь и только здесь — единственное поле, которого
    нет в этой схеме: закупочная цена не должна попадать в публичные ответы.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    slug: str
    name: str
    sku: str | None = None

    brand: BrandRef | None = None
    category: CategoryRef

    price: Decimal
    old_price: Decimal | None = None
    discount_percent: int = 0
    currency: str = "RUB"

    image_url: str | None = None
    image_alt: str | None = None

    availability: ProductStatus
    available_quantity: int
    in_stock: bool

    rating_avg: Decimal = Decimal("0")
    rating_count: int = 0
    warranty_months: int = 12


class ProductDetail(ProductCard):
    short_description: str | None = None
    description: str | None = None
    images: list[ProductImageOut] = Field(default_factory=list)
    specs: list[ProductSpecOut] = Field(default_factory=list)
    # Заполняется только для ролей manager/admin (раздел 6.1 ТЗ).
    purchase_price: Decimal | None = None


class FacetValue(BaseModel):
    value: str
    label: str | None = None
    count: int = 0


class FacetBrand(BaseModel):
    slug: str
    name: str
    count: int = 0


class FacetPrice(BaseModel):
    min: Decimal | None = None
    max: Decimal | None = None


class FacetAttribute(BaseModel):
    """Описание одного фильтра вместе с текущими значениями.

    Фронтенд строит форму целиком из этих данных: добавить новый фильтр в
    каталог можно, вставив строку в справочник, без правок кода.
    """

    key: str
    name: str
    data_type: str
    unit: str | None = None
    widget: str | None = None
    options: list[FacetValue] | None = None
    is_filterable: bool = False
    is_comparable: bool = True
    min: Decimal | None = None
    max: Decimal | None = None
    values: list[FacetValue] = Field(default_factory=list)


class Facets(BaseModel):
    brands: list[FacetBrand] = Field(default_factory=list)
    price: FacetPrice = Field(default_factory=FacetPrice)
    availability: list[FacetValue] = Field(default_factory=list)
    attributes: list[FacetAttribute] = Field(default_factory=list)


class ProductListResponse(BaseModel):
    items: list[ProductCard] = Field(default_factory=list)
    total: int = 0
    page: int = 1
    limit: int = 24
    pages: int = 0
    facets: Facets = Field(default_factory=Facets)


class CategoryResponse(BaseModel):
    category: CategoryRef
    parent: CategoryRef | None = None
    breadcrumb: list[CategoryRef] = Field(default_factory=list)
    products: ProductListResponse


class CategoryListResponse(BaseModel):
    items: list[CategoryRef] = Field(default_factory=list)


class BrandListResponse(BaseModel):
    items: list[BrandOut] = Field(default_factory=list)


class BrandResponse(BaseModel):
    brand: BrandOut
    products: ProductListResponse


class ProductDetailResponse(BaseModel):
    product: ProductDetail
    similar: list[ProductCard] = Field(default_factory=list)
    compatible: list[ProductCard] = Field(default_factory=list)


class SearchSuggestion(BaseModel):
    """Подсказка строки поиска (раздел 5.3 ТЗ)."""

    text: str
    type: str = "query"


class SearchResponse(BaseModel):
    products: list[ProductCard] = Field(default_factory=list)
    categories: list[CategoryRef] = Field(default_factory=list)
    brands: list[BrandOut] = Field(default_factory=list)
    suggestions: list[str] = Field(default_factory=list)


class HomeResponse(BaseModel):
    banners: list[dict] = Field(default_factory=list)
    categories: list[CategoryRef] = Field(default_factory=list)
    recommended: list[ProductCard] = Field(default_factory=list)
    discounted: list[ProductCard] = Field(default_factory=list)
    newest: list[ProductCard] = Field(default_factory=list)
    generated_at: datetime | None = None
