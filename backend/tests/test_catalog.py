"""Каталог: разбор параметров, фильтры, сортировка (разделы 5.2–5.3 ТЗ)."""

from __future__ import annotations

from decimal import Decimal
from urllib.parse import urlencode

import pytest
from starlette.datastructures import QueryParams

from app.core.errors import BadRequestError
from app.models.enums import ProductStatus
from app.repositories.catalog import effective_status
from app.schemas.catalog_query import (
    MAX_LIMIT,
    ProductQuery,
    SortOption,
    parse_product_query,
)


def parse(**params: str | list[str]) -> ProductQuery:
    """Разбирает параметры так же, как это делает роутер."""
    return parse_product_query(QueryParams(urlencode(params, doseq=True)))


class TestQueryParamsParsing:
    """Регрессия: QueryParams.get() отдаёт строку, а не список.

    Из-за этого `category=ssd` читался как «s», а `min_price=20000` — как «2».
    Фильтры не падали, а молча ничего не находили.
    """

    def test_category_is_read_whole(self) -> None:
        query = parse(category="ssd")
        assert query.category_slug == "ssd"

    def test_price_is_read_as_number_not_first_digit(self) -> None:
        query = parse(min_price="20000", max_price="30000")
        assert query.min_price == Decimal("20000")
        assert query.max_price == Decimal("30000")

    def test_price_accepts_comma_decimal(self) -> None:
        assert parse(min_price="1999,99").min_price == Decimal("1999.99")

    def test_multi_value_attribute_filter(self) -> None:
        query = parse(**{"attr.cpu.socket": ["AM5", "AM4"]})
        assert len(query.attributes) == 1
        assert query.attributes[0].key == "cpu.socket"
        assert set(query.attributes[0].values) == {"AM5", "AM4"}

    def test_attribute_range_filter(self) -> None:
        query = parse(**{"attr.cpu.tdp.min": "100", "attr.cpu.tdp.max": "130"})
        attribute = query.attributes[0]
        assert attribute.key == "cpu.tdp"
        assert attribute.min_value == Decimal("100")
        assert attribute.max_value == Decimal("130")

    def test_attribute_range_and_values_together(self) -> None:
        query = parse(**{"attr.ram.clock": ["3200"], "attr.ram.clock.min": "3000"})
        attribute = query.attributes[0]
        assert attribute.values == ("3200",)
        assert attribute.min_value == Decimal("3000")

    def test_plain_dict_is_supported(self) -> None:
        """Сервисные вызовы и тесты передают обычный словарь."""
        query = parse_product_query({"category": ["ssd"], "page": ["2"]})
        assert query.category_slug == "ssd"
        assert query.page == 2


class TestValidation:
    def test_limit_is_capped(self) -> None:
        """Раздел 12 ТЗ: без потолка limit выгружает весь каталог."""
        assert parse(limit="9999").limit == MAX_LIMIT

    def test_limit_minimum(self) -> None:
        assert parse(limit="0").limit == 1

    def test_negative_page_is_clamped(self) -> None:
        assert parse(page="-5").page == 1

    def test_unknown_sort_is_rejected(self) -> None:
        with pytest.raises(BadRequestError) as exc:
            parse(sort="vzlom")
        assert exc.value.code == "invalid_sort"

    def test_non_numeric_price_is_rejected(self) -> None:
        with pytest.raises(BadRequestError) as exc:
            parse(min_price="много")
        assert exc.value.code == "invalid_query_param"

    def test_rejected_price_names_the_field(self) -> None:
        """Фронтенд подсвечивает поле по ключу из fields."""
        with pytest.raises(BadRequestError) as exc:
            parse(min_price="много")
        assert "min_price" in exc.value.fields

    def test_negative_price_is_rejected(self) -> None:
        with pytest.raises(BadRequestError):
            parse(min_price="-100")

    def test_boolean_flags(self) -> None:
        assert parse(in_stock="true").in_stock is True
        assert parse(in_stock="false").in_stock is False
        assert parse(has_discount="1").has_discount is True
        assert parse().in_stock is None

    def test_search_is_truncated(self) -> None:
        query = parse(q="x" * 500)
        assert query.search is not None
        assert len(query.search) <= 200

    def test_blank_search_is_none(self) -> None:
        assert parse(q="   ").search is None

    def test_multiple_warranty_values(self) -> None:
        assert parse(warranty=["12", "36"]).warranty == (12, 36)

    def test_default_sort_is_popular(self) -> None:
        assert parse().sort is SortOption.POPULAR


class TestPaging:
    def test_offset_for_page(self) -> None:
        assert parse(page="3", limit="20").offset == 40

    def test_first_page_offset_is_zero(self) -> None:
        assert parse(page="1", limit="24").offset == 0


class TestAvailability:
    """Статус в интерфейсе считается по фактическому остатку."""

    @pytest.mark.parametrize(
        ("status", "available", "expected"),
        [
            (ProductStatus.IN_STOCK, 20, ProductStatus.IN_STOCK),
            (ProductStatus.IN_STOCK, 3, ProductStatus.LOW_STOCK),
            (ProductStatus.IN_STOCK, 0, ProductStatus.OUT_OF_STOCK),
            (ProductStatus.ON_ORDER, 0, ProductStatus.ON_ORDER),
            (ProductStatus.EXPECTED, 0, ProductStatus.EXPECTED),
            (ProductStatus.DISCONTINUED, 50, ProductStatus.DISCONTINUED),
        ],
    )
    def test_effective_status(
        self,
        status: ProductStatus,
        available: int,
        expected: ProductStatus,
    ) -> None:
        assert effective_status(status, available) is expected

    def test_low_stock_threshold_is_five(self) -> None:
        assert effective_status(ProductStatus.IN_STOCK, 5) is ProductStatus.LOW_STOCK
        assert effective_status(ProductStatus.IN_STOCK, 6) is ProductStatus.IN_STOCK
