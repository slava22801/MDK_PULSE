"""Фундамент: расширения PostgreSQL и базовая инфраструктура схемы

Revision ID: 0001_foundation
Revises:
Create Date: 2026-10-06

В этой ревизии таблиц бизнеса ещё нет — она готовит расширения, на которых
дальше строятся поиск (раздел 5.3 ТЗ) и индексы каталога (раздел 12).
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0001_foundation"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# pg_trgm — опечаткоустойчивый поиск («7800x3d», «сamsung 990»).
# unaccent + pg_trgm — поиск по русским названиям без учёта регистра и «ё».
# btree_gin — составные GIN-индексы «категория + бренд + цена» в каталоге.
EXTENSIONS = ("pg_trgm", "unaccent", "btree_gin")


def upgrade() -> None:
    for extension in EXTENSIONS:
        op.execute(f'CREATE EXTENSION IF NOT EXISTS "{extension}"')


def downgrade() -> None:
    # Расширения удаляем последними: от них могут зависеть индексы.
    for extension in reversed(EXTENSIONS):
        op.execute(f'DROP EXTENSION IF EXISTS "{extension}"')
