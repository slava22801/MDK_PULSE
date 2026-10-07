"""Отзывы (разделы 5.12 и 6.5 ТЗ)."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy import (
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

from app.models.enums import DiscountType, ReviewStatus
from app.models.mixins import Base, TimestampsMixin, UUIDPrimaryKeyMixin, pg_enum

if TYPE_CHECKING:
    from app.models.catalog import Product


class Review(UUIDPrimaryKeyMixin, TimestampsMixin, Base):
    """Раздел 7.11 ТЗ.

    Ссылка на order_id — не украшение: только покупатель может оставить отзыв,
    и только на товар из своего заказа. Проверка статуса заказа живёт в
    сервисе отзывов, но сама связь хранится здесь.
    """

    __tablename__ = "reviews"
    __table_args__ = (
        UniqueConstraint("user_id", "product_id", name="uq_reviews_user_product"),
        Index("ix_reviews_product_status_created", "product_id", "status", "created_at"),
        Index("ix_reviews_user", "user_id"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    product_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"),
        nullable=False,
    )
    order_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("orders.id", ondelete="SET NULL"),
        nullable=True,
    )

    rating: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)

    status: Mapped[ReviewStatus] = mapped_column(
        pg_enum(ReviewStatus, "review_status"),
        default=ReviewStatus.PENDING,
        index=True,
        nullable=False,
    )
    # Проверен покупкой: вычисляется по заказу, попадает в карточку товара.
    is_verified_purchase: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    moderation_comment: Mapped[str | None] = mapped_column(String(300), nullable=True)
    moderated_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    moderated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Relationship объявлена строкой, чтобы не тянуть каталог в этот модуль:
    # товар нужен только для вывода, а не для целостности на стороне отзыва.
    product: Mapped[Product] = relationship("Product", lazy="joined")

    def __repr__(self) -> str:
        return f"<Review product={self.product_id} rating={self.rating} status={self.status.value}>"


class ReviewImage(UUIDPrimaryKeyMixin, Base):
    """Фотографии в отзыве (раздел 5.12 ТЗ).

    Отдельная таблица, потому что ТЗ требует фото у отзыва, а в модели
    7.11 такой таблицы нет — потерялось при переносе требований в схему.
    """

    __tablename__ = "review_images"
    __table_args__ = (Index("ix_review_images_review", "review_id", "sort_order"),)

    review_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("reviews.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    image_url: Mapped[str] = mapped_column(String(500), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class PromoCode(UUIDPrimaryKeyMixin, TimestampsMixin, Base):
    """Раздел 7.12 ТЗ.

    Ограничения по категориям и исключённым товарам вынесены в отдельные
    таблицы: в модели 7.12 их нет, а раздел 6.5 требует.
    """

    __tablename__ = "promocodes"
    __table_args__ = (Index("ix_promocodes_active_period", "is_active", "valid_from", "valid_to"),)

    code: Mapped[str] = mapped_column(String(50), unique=True, index=True, nullable=False)
    description: Mapped[str | None] = mapped_column(String(300), nullable=True)

    discount_type: Mapped[DiscountType] = mapped_column(
        pg_enum(DiscountType, "discount_type"),
        nullable=False,
    )
    discount_value: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)

    min_order_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=0, nullable=False)
    max_discount_amount: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)

    usage_limit: Mapped[int | None] = mapped_column(Integer, nullable=True)
    used_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # Ограничение на одного пользователя (раздел 6.5 ТЗ).
    usage_limit_per_user: Mapped[int | None] = mapped_column(Integer, nullable=True)

    valid_from: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    valid_to: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True, nullable=False)

    # Раздел 6.5: промокод действует на выбранные категории и не действует
    # на исключённые товары. Пустые списки означают «без ограничений».
    categories: Mapped[list[PromoCodeCategory]] = relationship(
        back_populates="promocode",
        cascade="all, delete-orphan",
        lazy="selectin",
    )
    excluded: Mapped[list[PromoCodeProduct]] = relationship(
        back_populates="promocode",
        cascade="all, delete-orphan",
        lazy="selectin",
    )
    usages: Mapped[list[PromoCodeUsage]] = relationship(
        back_populates="promocode",
        cascade="all, delete-orphan",
        lazy="selectin",
    )


class PromoCodeCategory(UUIDPrimaryKeyMixin, Base):
    """Категории, на которые распространяется промокод (раздел 6.5 ТЗ)."""

    __tablename__ = "promocode_categories"
    __table_args__ = (
        UniqueConstraint("promocode_id", "category_id", name="uq_promocode_categories"),
    )

    promocode_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("promocodes.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    category_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("categories.id", ondelete="CASCADE"),
        nullable=False,
    )

    promocode: Mapped[PromoCode] = relationship(back_populates="categories")


class PromoCodeProduct(UUIDPrimaryKeyMixin, Base):
    """Исключённые из промокода товары (раздел 6.5 ТЗ)."""

    __tablename__ = "promocode_products"
    __table_args__ = (UniqueConstraint("promocode_id", "product_id", name="uq_promocode_products"),)

    promocode_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("promocodes.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    product_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"),
        nullable=False,
    )

    promocode: Mapped[PromoCode] = relationship(back_populates="excluded")


class PromoCodeUsage(UUIDPrimaryKeyMixin, Base):
    """История применений промокода.

    Нужна для ограничения «сколько раз один пользователь использовал код»
    и для корректного ``used_count`` при параллельных заказах.
    """

    __tablename__ = "promocode_usages"
    __table_args__ = (
        UniqueConstraint("promocode_id", "order_id", name="uq_promocode_usages_order"),
        Index("ix_promocode_usages_user", "promocode_id", "user_id"),
    )

    promocode_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("promocodes.id", ondelete="CASCADE"),
        nullable=False,
    )
    order_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("orders.id", ondelete="CASCADE"),
        nullable=False,
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    discount_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    promocode: Mapped[PromoCode] = relationship(back_populates="usages")
