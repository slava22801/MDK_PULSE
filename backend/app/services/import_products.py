"""Импорт товаров из CSV и XLSX (раздел 14 ТЗ).

Порядок проверок задан ТЗ дословно и соблюдается:

1. проверить формат файла;
2. проверить обязательные поля;
3. проверить уникальность артикула;
4. проверить существование категории и бренда;
5. проверить корректность цены и количества;
6. показать предварительный отчёт;
7. импортировать корректные строки;
8. показать ошибки по некорректным строкам.

Пункт 6 — не украшение: ``dry_run`` собирает отчёт и ничего не пишет,
поэтому сотрудник может проверить файл до реального импорта.
"""

from __future__ import annotations

import csv
import io
import logging
import uuid
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import BadRequestError
from app.models.catalog import Brand, Category, Product
from app.models.enums import ProductStatus
from app.models.user import User
from app.schemas.admin import ImportReport, ImportRowError
from app.services.admin_products import slugify
from app.services.audit import AuditService

logger = logging.getLogger(__name__)

# Обязательные колонки из раздела 14 ТЗ.
REQUIRED_COLUMNS = (
    "Артикул",
    "Название",
    "Категория",
    "Бренд",
    "Цена",
    "Количество",
)

# Разумные синонимы заголовков: файлы поставщиков почти никогда не
# совпадают с нашей формой слова в слово.
COLUMN_ALIASES = {
    "артикул": "Артикул",
    "sku": "Артикул",
    "код": "Артикул",
    "название": "Название",
    "наименование": "Название",
    "товар": "Название",
    "категория": "Категория",
    "бренд": "Бренд",
    "производитель": "Бренд",
    "цена": "Цена",
    "цена продажи": "Цена",
    "старая цена": "Старая цена",
    "количество": "Количество",
    "остаток": "Количество",
    "гарантия": "Гарантия",
    "вес": "Вес",
    "описание": "Описание",
    "изображение": "Изображение",
    "артикул производителя": "Артикул производителя",
}


@dataclass
class ParsedRow:
    """Строка файла, разобранная в значения."""

    row_number: int
    sku: str
    name: str
    category: str
    brand: str
    price: Decimal
    quantity: int
    old_price: Decimal | None = None
    warranty_months: int = 12
    weight: Decimal | None = None
    description: str | None = None
    image_url: str | None = None

    def spec_fields(self) -> dict[str, str]:
        extra: dict[str, str] = {}
        if self.weight is not None:
            extra["common.weight"] = str(self.weight)
        return extra


class ProductImporter:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.audit = AuditService(session)
        self.errors: list[ImportRowError] = []
        self.skipped_rows: list[tuple[int, str]] = []
        # Число строк данных в файле — включая те, что отбракованы при разборе.
        # Отчёт раздела 14 показывает сотруднику охват файла целиком, иначе
        # строка без артикула просто исчезла бы из отчёта.
        self.file_rows = 0

    # ── Разбор файла ──

    def parse_file(self, filename: str, content: bytes) -> list[ParsedRow]:
        """Читает CSV или XLSX и возвращает разобранные строки.

        Некорректные строки не прерывают разбор: собираются в ``self.errors``
        и показываются сотруднику отдельным списком (пункты 8 и 9 ТЗ).
        """
        suffix = filename.lower().rsplit(".", 1)[-1]
        if suffix == "csv":
            raw_rows = self._read_csv(content)
        elif suffix in {"xlsx", "xlsm"}:
            raw_rows = self._read_xlsx(content)
        else:
            raise BadRequestError(
                "Поддерживаются только файлы .csv и .xlsx",
                code="unsupported_format",
                fields={"file": f"получено «.{suffix}»"},
            )

        if not raw_rows:
            raise BadRequestError("Файл пуст", code="empty_file")

        header = [self._normalize(cell) for cell in raw_rows[0]]
        missing = [column for column in REQUIRED_COLUMNS if column not in header]
        if missing:
            raise BadRequestError(
                "В файле нет обязательных колонок: " + ", ".join(missing),
                code="missing_columns",
                fields={"file": "добавьте: " + ", ".join(missing)},
            )

        data_rows = raw_rows[1:]
        # Строки данных в файле, включая те, что будут отбракованы при
        # разборе: отчёт раздела 14 показывает сотруднику охват файла
        # целиком, иначе строки без артикула просто исчезли бы.
        self.file_rows = sum(1 for raw in data_rows if any(str(cell).strip() for cell in raw))
        rows = [self._parse_row(index, header, raw) for index, raw in enumerate(data_rows, start=2)]
        return [row for row in rows if row is not None]

    def _normalize(self, value: object) -> str:
        text = str(value or "").strip()
        return COLUMN_ALIASES.get(text.lower(), text)

    def _read_csv(self, content: bytes) -> list[list[str]]:
        # Разделитель определяется по первой строке: русские выгрузки
        # часто приходят с «;» и по умолчанию читались бы одной колонкой.
        sample = content[:4096].decode("utf-8", errors="replace")
        delimiter = ";" if sample.count(";") > sample.count(",") else ","
        try:
            text = content.decode("utf-8-sig")
        except UnicodeDecodeError:
            # cp1251 — стандартная кодировка выгрузок из 1С.
            text = content.decode("cp1251")

        reader = csv.reader(io.StringIO(text), delimiter=delimiter)
        return [row for row in reader if any(cell.strip() for cell in row)]

    def _read_xlsx(self, content: bytes) -> list[list[str]]:
        from openpyxl import load_workbook

        workbook = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
        sheet = workbook.active
        rows = [
            ["" if cell is None else str(cell) for cell in row]
            for row in sheet.iter_rows(values_only=True)
        ]
        workbook.close()
        return [row for row in rows if any(str(cell).strip() for cell in row)]

    def _parse_row(
        self,
        row_number: int,
        header: list[str],
        raw: list[str],
    ) -> ParsedRow | None:
        if not any(str(cell).strip() for cell in raw):
            return None

        values = {
            header[index]: str(cell).strip()
            for index, cell in enumerate(raw)
            if index < len(header)
        }

        sku = values.get("Артикул", "").strip()
        name = values.get("Название", "").strip()

        # Пункты 2 и 5 ТЗ: обязательные поля и корректность чисел.
        if not sku:
            self._fail(row_number, "Артикул", "Не указан артикул")
            return None
        if not name:
            self._fail(row_number, "Название", "Не указано название")
            return None

        price = self._decimal(values.get("Цена"), row_number, "Цена")
        if price is None or price <= 0:
            self._fail(row_number, "Цена", "Цена должна быть больше нуля")
            return None

        quantity = self._integer(values.get("Количество"), row_number, "Количество")
        if quantity is None or quantity < 0:
            self._fail(row_number, "Количество", "Количество должно быть неотрицательным целым")
            return None

        category = values.get("Категория", "").strip()
        brand = values.get("Бренд", "").strip()
        if not category:
            self._fail(row_number, "Категория", "Не указана категория")
            return None
        if not brand:
            self._fail(row_number, "Бренд", "Не указан бренд")
            return None

        return ParsedRow(
            row_number=row_number,
            sku=sku,
            name=name,
            category=category,
            brand=brand,
            price=price,
            quantity=quantity,
            old_price=self._decimal(values.get("Старая цена"), row_number, "Старая цена"),
            warranty_months=self._integer(values.get("Гарантия"), row_number, "Гарантия") or 12,
            weight=self._decimal(values.get("Вес"), row_number, "Вес"),
            description=values.get("Описание") or None,
            image_url=values.get("Изображение") or None,
        )

    def _decimal(
        self,
        raw: str | None,
        row_number: int,
        column: str,
    ) -> Decimal | None:
        if raw is None or str(raw).strip() == "":
            return None
        original = str(raw).strip()
        # Прайс может содержать «12 990,00 ₽» — убираем пробелы и символ валюты.
        text = original.replace(" ", "").replace(" ", "").replace(",", ".")
        text = "".join(ch for ch in text if ch.isdigit() or ch in ".-")
        if not text:
            # В значении не осталось ни одной цифры («не число», «н/д»):
            # сообщаем об этом прямо, иначе сотрудник увидит «цена должна
            # быть больше нуля» и не поймёт, в чём дело.
            self._fail(row_number, column, f"«{original}» не является числом")
            return None
        try:
            return Decimal(text)
        except InvalidOperation:
            self._fail(row_number, column, f"«{original}» не является числом")
            return None

    def _integer(self, raw: str | None, row_number: int, column: str) -> int | None:
        value = self._decimal(raw, row_number, column)
        if value is None:
            return None
        try:
            return int(value)
        except (ValueError, OverflowError):
            self._fail(row_number, column, f"«{raw}» не является целым числом")
            return None

    def _fail(self, row_number: int, column: str | None, message: str) -> None:
        self.errors.append(ImportRowError(row_number=row_number, column=column, message=message))

    # ── Сверка с базой ──

    async def validate(
        self,
        rows: list[ParsedRow],
        *,
        existing_skus: set[str] | None = None,
    ) -> tuple[dict[str, Category], dict[str, Brand]]:
        """Проверяет уникальность артикулов и существование справочников.

        Пункты 3 и 4 ТЗ. Возвращает справочники, найденные в базе: категории и
        бренды из файла, которых нет в каталоге, считаются ошибками строк.
        """
        categories = {
            row.slug: row for row in (await self.session.execute(select(Category))).scalars().all()
        }
        brands = {
            row.slug: row for row in (await self.session.execute(select(Brand))).scalars().all()
        }
        categories_by_name = {row.name.lower(): row for row in categories.values()}
        brands_by_name = {row.name.lower(): row for row in brands.values()}

        if existing_skus is None:
            from sqlalchemy import func

            known = (
                await self.session.execute(select(func.count()).select_from(Product))
            ).scalar_one()
            existing_skus = set()
            if known:
                from sqlalchemy import select as _select

                rows_ = (await self.session.execute(_select(Product.sku))).scalars().all()
                existing_skus = set(rows_)

        seen_in_file: set[str] = set()
        resolved_categories: dict[str, Category] = {}
        resolved_brands: dict[str, Brand] = {}

        for row in rows:
            if row.sku in seen_in_file:
                self._fail(
                    row.row_number,
                    "Артикул",
                    f"Артикул «{row.sku}» повторяется в файле",
                )
                continue
            seen_in_file.add(row.sku)

            if row.sku in existing_skus:
                self.skipped_rows.append(
                    (row.row_number, f"Артикул «{row.sku}» уже есть в каталоге")
                )
                continue

            category = categories.get(slugify(row.category)) or categories_by_name.get(
                row.category.lower()
            )
            if category is None:
                self._fail(row.row_number, "Категория", f"Категория «{row.category}» не найдена")
                continue
            resolved_categories[row.category] = category

            brand = brands.get(slugify(row.brand)) or brands_by_name.get(row.brand.lower())
            if brand is None:
                self._fail(row.row_number, "Бренд", f"Бренд «{row.brand}» не найден")
                continue
            resolved_brands[row.brand] = brand

        return resolved_categories, resolved_brands

    # ── Импорт ──

    async def run(
        self,
        rows: list[ParsedRow],
        *,
        categories: dict[str, Category],
        brands: dict[str, Brand],
        dry_run: bool,
        actor: User,
        ip_address: str | None = None,
    ) -> ImportReport:
        """Импортирует строки (или только считает их при ``dry_run``)."""
        created = 0
        updated = 0

        for row in rows:
            category = categories.get(row.category)
            brand = brands.get(row.brand)
            if category is None or brand is None:
                continue

            existing = (
                await self.session.execute(select(Product).where(Product.sku == row.sku))
            ).scalar_one_or_none()

            if existing is None:
                product = Product(
                    # _unique_slug — async-метод (идёт в базу на проверку
                    # занятости), поэтому его нужно дождаться: без await
                    # в slug попал бы объект ожидания.
                    slug=await self._unique_slug(row.name),
                    sku=row.sku,
                    name=row.name,
                    short_description=(row.description or "")[:500] or None,
                    description=row.description,
                    category_id=category.id,
                    brand_id=brand.id,
                    price=row.price,
                    old_price=row.old_price,
                    purchase_price=(row.price * Decimal("0.82")).quantize(Decimal("0.01")),
                    stock_quantity=row.quantity,
                    status=(
                        ProductStatus.IN_STOCK if row.quantity > 0 else ProductStatus.OUT_OF_STOCK
                    ),
                    warranty_months=row.warranty_months,
                    weight=row.weight,
                )
                self.session.add(product)
                await self.session.flush()
                created += 1
            else:
                # Цена и количество обновляются, описание — только если
                # в файле оно есть: иначе импорт затирал бы описание,
                # написанное вручную.
                existing.price = row.price
                existing.old_price = row.old_price
                existing.stock_quantity = row.quantity
                if row.description:
                    existing.description = row.description
                updated += 1

            if row.image_url:
                from app.models.catalog import ProductImage

                has_image = await self.session.execute(
                    select(ProductImage).where(ProductImage.product_id == product.id)
                )
                if not has_image.scalars().first():
                    self.session.add(
                        ProductImage(
                            product_id=product.id,
                            image_url=row.image_url,
                            alt=row.name,
                            is_main=True,
                        )
                    )

        report = ImportReport(
            total_rows=self.file_rows or len(rows),
            created=created,
            updated=updated,
            skipped=len(self.skipped_rows),
            errors=self.errors,
        )

        if dry_run:
            report.message = (
                f"Предварительный отчёт: из {len(rows)} строк готово к импорту "
                f"{created + updated}, пропущено {report.skipped}, ошибок {len(self.errors)}. "
                "Файл не изменён — снимите галочку «только проверить», чтобы загрузить."
            )
            await self.session.rollback()
            return report

        await self.audit.record(
            actor,
            action="products.imported",
            entity_type="product",
            details={
                "rows": len(rows),
                "created": created,
                "updated": updated,
                "skipped": report.skipped,
                "errors": len(self.errors),
            },
            ip_address=ip_address,
        )
        await self.session.commit()
        report.message = (
            f"Импортировано: создано {created}, обновлено {updated}, "
            f"пропущено {report.skipped}, ошибок {len(self.errors)}."
        )
        return report

    async def _unique_slug(self, name: str) -> str:
        from sqlalchemy import func

        base = slugify(name) or f"import-{uuid.uuid4().hex[:8]}"
        candidate = base
        suffix = 1
        while True:
            exists = (
                await self.session.execute(
                    select(func.count()).select_from(Product).where(Product.slug == candidate)
                )
            ).scalar_one()
            if not exists:
                return candidate
            suffix += 1
            candidate = f"{base}-{suffix}"
