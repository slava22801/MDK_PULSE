"""Параметры выборки каталога: разбор query-строки в типизированный объект.

Разбор живёт отдельно от репозитория, потому что это единственное место,
где пользовательский ввод превращается в SQL-условия. Все значения проходят
здесь приведение к нужному типу и проверку диапазона — до того, как попадут
в запрос (раздел 10 ТЗ: входные данные валидируются на backend).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from enum import StrEnum

from app.core.errors import BadRequestError

MAX_LIMIT = 100
DEFAULT_LIMIT = 24


class SortOption(StrEnum):
    """Раздел 5.2 ТЗ: шесть вариантов сортировки."""

    POPULAR = "popular"
    PRICE_ASC = "price_asc"
    PRICE_DESC = "price_desc"
    RATING = "rating"
    NEWEST = "newest"
    DISCOUNT = "discount"


SORT_LABELS: dict[SortOption, str] = {
    SortOption.POPULAR: "по популярности",
    SortOption.PRICE_ASC: "сначала дешёвые",
    SortOption.PRICE_DESC: "сначала дорогие",
    SortOption.RATING: "по рейтингу",
    SortOption.NEWEST: "по новизне",
    SortOption.DISCOUNT: "по размеру скидки",
}


@dataclass(frozen=True)
class AttributeFilter:
    """Выборка по одной характеристике.

    ``values`` — множественный выбор для enum/checkbox, ``min_value``/``max_value``
    — диапазон для числа. Оба заполняются, если клиент прислал оба вида.
    """

    key: str
    values: tuple[str, ...] = ()
    min_value: Decimal | None = None
    max_value: Decimal | None = None


@dataclass(frozen=True)
class ProductQuery:
    """Нормализованные параметры выборки каталога."""

    category_slug: str | None = None
    category_id: uuid.UUID | None = None
    brand_slug: str | None = None
    search: str | None = None

    min_price: Decimal | None = None
    max_price: Decimal | None = None
    in_stock: bool | None = None
    min_rating: Decimal | None = None
    has_discount: bool | None = None
    warranty: tuple[int, ...] = ()

    sort: SortOption = SortOption.POPULAR
    page: int = 1
    limit: int = DEFAULT_LIMIT

    attributes: tuple[AttributeFilter, ...] = ()

    # Внутренние флаги: не приходят от клиента, нужны репозиторию.
    include_descendants: bool = False

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.limit


def _to_decimal(raw: str | None, field_name: str) -> Decimal | None:
    if raw is None or raw == "":
        return None
    try:
        value = Decimal(raw.replace(",", "."))
    except (InvalidOperation, ValueError) as exc:
        raise BadRequestError(
            f"Некорректное значение параметра {field_name}",
            code="invalid_query_param",
            fields={field_name: f"«{raw}» не является числом"},
        ) from exc
    if value < 0:
        raise BadRequestError(
            f"Параметр {field_name} не может быть отрицательным",
            code="invalid_query_param",
            fields={field_name: "ожидается неотрицательное число"},
        )
    return value


def _to_bool(raw: str | None) -> bool | None:
    if raw is None or raw == "":
        return None
    return raw.lower() in {"1", "true", "yes", "on"}


def _to_int(raw: str | None, field_name: str, *, minimum: int, maximum: int) -> int | None:
    if raw is None or raw == "":
        return None
    try:
        value = int(raw)
    except ValueError as exc:
        raise BadRequestError(
            f"Некорректное значение параметра {field_name}",
            code="invalid_query_param",
            fields={field_name: f"«{raw}» не является целым числом"},
        ) from exc
    return max(minimum, min(value, maximum))


def _as_multimap(params: object) -> dict[str, list[str]]:
    """Приводит query-параметры к единому виду «ключ → список значений».

    ``starlette.datastructures.QueryParams.get()`` возвращает **строку**, а
    не список, и обращение ``params.get(name)[0]`` молча брало первый символ:
    ``category=ssd`` превращалось в ``"s"``, ``min_price=20000`` — в ``"2"``.
    Фильтры не падали, а просто ничего не находили — самый неприятный вид
    поломки. Поэтому ``QueryParams`` разворачивается через ``multi_items()``,
    а обычный словарь берётся как есть.
    """
    if hasattr(params, "multi_items"):
        collected: dict[str, list[str]] = {}
        for key, value in params.multi_items():  # type: ignore[attr-defined]
            collected.setdefault(key, []).append(value)
        return collected
    return {
        key: list(value) if isinstance(value, list | tuple) else [value]
        for key, value in dict(params).items()
    }  # type: ignore[arg-type]


def parse_product_query(raw_params: object) -> ProductQuery:
    """Собирает :class:`ProductQuery` из query-параметров запроса.

    Атрибутные фильтры читаются как ``attr.<key>``, ``attr.<key>.min``,
    ``attr.<key>.max`` — единый синтаксис вместо отдельных параметров под
    каждую характеристику.
    """
    params = _as_multimap(raw_params)

    def first(name: str) -> str | None:
        values = params.get(name)
        return values[0] if values else None

    def all_of(name: str) -> tuple[str, ...]:
        return tuple(v for v in params.get(name, []) if v != "")

    sort_raw = first("sort") or SortOption.POPULAR.value
    try:
        sort = SortOption(sort_raw)
    except ValueError as exc:
        raise BadRequestError(
            f"Неизвестная сортировка «{sort_raw}»",
            code="invalid_sort",
            fields={"sort": "допустимо: " + ", ".join(s.value for s in SortOption)},
        ) from exc

    search = (first("q") or "").strip() or None
    if search and len(search) > 200:
        search = search[:200]

    warranty_raw = all_of("warranty")
    warranty: tuple[int, ...] = ()
    if warranty_raw:
        parsed = set()
        for item in warranty_raw:
            months = _to_int(item, "warranty", minimum=0, maximum=600)
            if months is not None:
                parsed.add(months)
        warranty = tuple(sorted(parsed))

    attributes = _parse_attribute_filters(params)

    return ProductQuery(
        category_slug=(first("category") or "").strip() or None,
        brand_slug=(first("brand") or "").strip() or None,
        search=search,
        min_price=_to_decimal(first("min_price"), "min_price"),
        max_price=_to_decimal(first("max_price"), "max_price"),
        in_stock=_to_bool(first("in_stock")),
        min_rating=_to_decimal(first("min_rating"), "min_rating"),
        has_discount=_to_bool(first("has_discount")),
        warranty=warranty,
        sort=sort,
        page=_to_int(first("page"), "page", minimum=1, maximum=100_000) or 1,
        limit=_to_int(first("limit"), "limit", minimum=1, maximum=MAX_LIMIT) or DEFAULT_LIMIT,
        attributes=attributes,
        include_descendants=(first("include_descendants") or "").lower() in {"1", "true"},
    )


def _parse_attribute_filters(params: dict[str, list[str]]) -> tuple[AttributeFilter, ...]:
    """Собирает фильтры по характеристикам из параметров ``attr.*``.

    Ключи вида ``attr.cpu.socket.min`` превращаются в ключ ``cpu.socket`` с
    нижней границей; одноимённые значения собираются в множественный выбор.
    """
    buckets: dict[str, dict[str, object]] = {}

    for raw_key, raw_values in params.items():
        if not raw_key.startswith("attr."):
            continue
        body = raw_key[len("attr.") :]
        if not body:
            continue

        if body.endswith(".min"):
            key, kind = body[: -len(".min")], "min"
        elif body.endswith(".max"):
            key, kind = body[: -len(".max")], "max"
        else:
            key, kind = body, "values"

        bucket = buckets.setdefault(key, {"values": [], "min": None, "max": None})
        bucket[kind] = raw_values if kind == "values" else raw_values[0]

    filters: list[AttributeFilter] = []
    for key, bucket in buckets.items():
        raw_min = bucket.get("min")
        raw_max = bucket.get("max")
        filters.append(
            AttributeFilter(
                key=key,
                values=tuple(v for v in bucket.get("values", []) if v),  # type: ignore[union-attr]
                min_value=_to_decimal(str(raw_min) if raw_min else None, f"attr.{key}.min"),
                max_value=_to_decimal(str(raw_max) if raw_max else None, f"attr.{key}.max"),
            )
        )
    return tuple(filters)


@dataclass
class CatalogResult:
    """Результат выборки каталога вместе с фасетами."""

    items: list = field(default_factory=list)
    total: int = 0
    pages: int = 0
