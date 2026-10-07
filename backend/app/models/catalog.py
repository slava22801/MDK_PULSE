"""Каталог: категории, бренды, товары, изображения, характеристики (разделы 5–7 ТЗ)."""

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
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.enums import (
    AttributeDataType,
    FilterWidget,
    ProductRelationKind,
    ProductStatus,
)
from app.models.mixins import Base, TimestampsMixin, UUIDPrimaryKeyMixin, pg_enum

MONEY = Numeric(12, 2)


class Category(UUIDPrimaryKeyMixin, TimestampsMixin, Base):
    """Раздел 7.2 ТЗ: дерево категорий через parent_id."""

    __tablename__ = "categories"
    __table_args__ = (
        UniqueConstraint("slug", name="uq_categories_slug"),
        Index("ix_categories_parent_sort", "parent_id", "sort_order"),
        Index("ix_categories_active_sort", "is_active", "sort_order"),
    )

    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("categories.id", ondelete="RESTRICT"),
        nullable=True,
    )
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    slug: Mapped[str] = mapped_column(String(150), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # 0 — корень, 1 — вложенная. Ограничение в схеме: максимум два уровня,
    # как в примере структуры из раздела 6.2 ТЗ.
    level: Mapped[int] = mapped_column(SmallInteger, default=0, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    parent: Mapped[Category | None] = relationship(
        remote_side="Category.id", back_populates="children"
    )
    children: Mapped[list[Category]] = relationship(
        back_populates="parent",
        cascade="save-update",
        lazy="selectin",
    )

    def __repr__(self) -> str:
        return f"<Category {self.slug} level={self.level}>"


class Brand(UUIDPrimaryKeyMixin, TimestampsMixin, Base):
    """Раздел 7.3 ТЗ."""

    __tablename__ = "brands"
    __table_args__ = (UniqueConstraint("slug", name="uq_brands_slug"),)

    name: Mapped[str] = mapped_column(String(150), nullable=False, unique=True)
    slug: Mapped[str] = mapped_column(String(150), nullable=False)
    logo_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    def __repr__(self) -> str:
        return f"<Brand {self.name}>"


class AttributeDef(UUIDPrimaryKeyMixin, TimestampsMixin, Base):
    """Справочник характеристик: одна строка = один фильтр в каталоге.

    Добавление характеристики в каталог не требует правок кода ни на бэке,
    ни на фронте: фронт строит фильтры по этому справочнику.
    """

    __tablename__ = "attribute_defs"
    __table_args__ = (
        UniqueConstraint("key", name="uq_attribute_defs_key"),
        Index("ix_attribute_defs_category_filterable", "category_id", "is_filterable"),
    )

    category_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("categories.id", ondelete="CASCADE"),
        nullable=True,
    )
    key: Mapped[str] = mapped_column(String(100), nullable=False)
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    data_type: Mapped[AttributeDataType] = mapped_column(
        pg_enum(AttributeDataType, "attribute_data_type"),
        default=AttributeDataType.TEXT,
        nullable=False,
    )
    unit: Mapped[str | None] = mapped_column(String(20), nullable=True)
    filter_widget: Mapped[FilterWidget | None] = mapped_column(
        pg_enum(FilterWidget, "filter_widget"),
        nullable=True,
    )
    # Список значений для data_type=enum: [{"value": "am5", "label": "AM5"}]
    options: Mapped[list | None] = mapped_column(JSON, nullable=True)
    is_filterable: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_comparable: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class Product(UUIDPrimaryKeyMixin, TimestampsMixin, Base):
    """Раздел 7.4 ТЗ плюс поля из раздела 6.1.

    Доступное количество не хранится колонкой: оно вычисляется как
    ``stock_quantity - reserved_quantity``. Хранить производное значение
    опасно — оно расходится с исходными данными при любом параллельном
    изменении остатка.
    """

    __tablename__ = "products"
    __table_args__ = (
        UniqueConstraint("slug", name="uq_products_slug"),
        UniqueConstraint("sku", name="uq_products_sku"),
        # Каталог почти всегда читается по связке «категория + статус + цена»
        # и сортируется по одному из шести полей (раздел 5.2 ТЗ).
        Index("ix_products_catalog", "category_id", "status", "price"),
        Index("ix_products_brand_price", "brand_id", "price"),
        Index("ix_products_created_at", "created_at"),
        # Опечаткоустойчивый поиск (раздел 5.3 ТЗ): GIN по триграммам.
        # Нужен именно GIN: operator class gin_trgm_ops не существует для btree.
        Index(
            "ix_products_name_trgm",
            "name",
            postgresql_using="gin",
            postgresql_ops={"name": "gin_trgm_ops"},
        ),
        Index(
            "ix_products_sku_trgm",
            "sku",
            postgresql_using="gin",
            postgresql_ops={"sku": "gin_trgm_ops"},
        ),
        Index("ix_products_rating", "rating_avg", "rating_count"),
    )

    category_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("categories.id", ondelete="RESTRICT"),
        index=True,
        nullable=False,
    )
    brand_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("brands.id", ondelete="SET NULL"),
        index=True,
        nullable=True,
    )

    name: Mapped[str] = mapped_column(String(300), nullable=False)
    slug: Mapped[str] = mapped_column(String(300), nullable=False)
    sku: Mapped[str] = mapped_column(String(64), nullable=False)
    model: Mapped[str | None] = mapped_column(String(150), index=True, nullable=True)

    short_description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    price: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    old_price: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)
    # Закупочная цена — только для админки, в публичные API не выводится.
    purchase_price: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)
    currency: Mapped[str] = mapped_column(String(3), default="RUB", nullable=False)

    stock_quantity: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    reserved_quantity: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    min_stock: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    status: Mapped[ProductStatus] = mapped_column(
        pg_enum(ProductStatus, "product_status"),
        default=ProductStatus.IN_STOCK,
        index=True,
        nullable=False,
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    warranty_months: Mapped[int] = mapped_column(Integer, default=12, nullable=False)

    weight: Mapped[Decimal | None] = mapped_column(Numeric(10, 3), nullable=True)
    width: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)
    height: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)
    length: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)

    # Денормализованы ради сортировки по рейтингу и популярности: агрегация
    # по отзывам на каждый запрос каталога даёт N+1 и медленный список.
    rating_avg: Mapped[Decimal] = mapped_column(Numeric(3, 2), default=0, nullable=False)
    rating_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # Счётчик «товар купили» для сортировки по популярности (раздел 5.2).
    sales_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    seo_title: Mapped[str | None] = mapped_column(String(300), nullable=True)
    seo_description: Mapped[str | None] = mapped_column(String(500), nullable=True)

    category: Mapped[Category] = relationship(lazy="joined")
    brand: Mapped[Brand | None] = relationship(lazy="joined")
    # Галерея грузится одним дополнительным запросом на страницу каталога,
    # а не по запросу на товар: список из 24 карточек иначе дал бы 24 запроса.
    images: Mapped[list[ProductImage]] = relationship(
        back_populates="product",
        cascade="all, delete-orphan",
        lazy="selectin",
        # Порядок задан строкой: класс ProductImage объявлен ниже, и
        # выражение из него вычислялось бы в момент создания модели.
        order_by=(
            "(ProductImage.is_main.desc(), ProductImage.sort_order, ProductImage.created_at)"
        ),
    )

    @property
    def available_quantity(self) -> int:
        """То, что реально можно купить. Не кэшируем — считаем на лету."""
        return max(0, self.stock_quantity - self.reserved_quantity)

    @property
    def discount_percent(self) -> int:
        if not self.old_price or self.old_price <= self.price or self.price <= 0:
            return 0
        return int(round((1 - self.price / self.old_price) * 100))

    @property
    def is_purchasable(self) -> bool:
        return self.is_active and self.status.is_purchasable and self.available_quantity > 0

    def __repr__(self) -> str:
        return f"<Product {self.sku} {self.name!r}>"


class ProductImage(UUIDPrimaryKeyMixin, Base):
    """Раздел 7.5 ТЗ: галерея товара."""

    __tablename__ = "product_images"
    __table_args__ = (Index("ix_product_images_product_sort", "product_id", "sort_order"),)

    product_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    image_url: Mapped[str] = mapped_column(String(500), nullable=False)
    alt: Mapped[str | None] = mapped_column(String(255), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_main: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    product: Mapped[Product] = relationship(back_populates="images")


class ProductSpec(UUIDPrimaryKeyMixin, Base):
    """Значение характеристики товара.

    Типизированные колонки вместо EAV из раздела 7.6 ТЗ: диапазонные фильтры
    («TDP 65–125 Вт») и сортировка по характеристике работают только по
    индексируемым числовым полям.
    """

    __tablename__ = "product_specs"
    __table_args__ = (
        UniqueConstraint("product_id", "attribute_id", name="uq_product_specs_product_attribute"),
        # Диапазонные фильтры: «attribute = X И value_num BETWEEN a И b».
        Index("ix_product_specs_attr_num", "attribute_id", "value_num"),
        # Фильтры по списку значений (производитель, сокет, тип памяти).
        Index("ix_product_specs_attr_text", "attribute_id", "value_text"),
    )

    product_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    attribute_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("attribute_defs.id", ondelete="CASCADE"),
        nullable=False,
    )
    value_num: Mapped[Decimal | None] = mapped_column(Numeric(16, 4), nullable=True)
    value_text: Mapped[str | None] = mapped_column(String(255), nullable=True)
    value_bool: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    attribute: Mapped[AttributeDef] = relationship(lazy="joined")


class ProductRelation(UUIDPrimaryKeyMixin, Base):
    """Совместимые и похожие товары (раздел 5.4 ТЗ)."""

    __tablename__ = "product_relations"
    __table_args__ = (
        UniqueConstraint("product_id", "related_id", name="uq_product_relations_pair"),
        Index("ix_product_relations_product_kind", "product_id", "kind"),
    )

    product_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    related_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    kind: Mapped[ProductRelationKind] = mapped_column(
        pg_enum(ProductRelationKind, "product_relation_kind"),
        default=ProductRelationKind.SIMILAR,
        nullable=False,
    )
