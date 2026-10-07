"""Цена товара на момент добавления в избранное

Revision ID: 0003_favorite_price
Revises: 09aba3e82156
Create Date: 2026-10-07

Раздел 5.6 ТЗ требует показывать покупателю изменение цены товара из
избранного. В модели 7.10 ТЗ поля нет — без сохранённой цены изменение
определить нечем: актуальная цена меняется молча.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0003_favorite_price"
down_revision: str | None = "09aba3e82156"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "favorites",
        sa.Column("price_at_add", sa.Numeric(12, 2), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("favorites", "price_at_add")
