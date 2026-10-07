"""Наполнение каталога демо-данными (раздел 16 ТЗ).

Справочник характеристик задаётся здесь же и один на все категории:
набор фильтров в каталоге не зашит в код, а берётся из таблицы
``attribute_defs``. Чтобы добавить фильтр, достаточно дописать строку.

Данные — правдоподобные характеристики реальных позиций, а не мусор:
по ним удобно проверять фильтры («TDP от 65 до 125 Вт» и правда отсекает
что-то) и сравнение товаров.
"""

from __future__ import annotations

import logging
from decimal import Decimal

from sqlalchemy import select

from app.models.catalog import AttributeDef, Brand, Category, Product, ProductSpec
from app.models.content import Banner
from app.models.enums import AttributeDataType, FilterWidget

logger = logging.getLogger(__name__)

# ── Справочник характеристик ──
# (ключ, название, тип, единица, виджет, сортировка, сравнивать ли, значения для enum)
# Справочник характеристик каталога.
# Формат кортежа: ключ, название, тип, единица, виджет фильтра, сортировка,
# участвует ли в сравнении, значения для enum.
# Общие характеристики (common.*) подходят всем категориям, остальные
# привязываются к конкретной через маски в CATEGORY_ATTRIBUTES.
_COMMON = "common."
_ATTRIBUTES_COMMON: list[tuple] = [
    ("common.brand", "Производитель", AttributeDataType.TEXT, None, None, 10, True, None),
    (
        "common.warranty",
        "Гарантия",
        AttributeDataType.NUMBER,
        "мес.",
        FilterWidget.SELECT,
        20,
        True,
        None,
    ),
    ("common.weight", "Вес", AttributeDataType.NUMBER, "кг", None, 30, True, None),
    (
        "common.memory_type",
        "Тип памяти",
        AttributeDataType.ENUM,
        None,
        FilterWidget.CHECKBOX,
        90,
        True,
        ["DDR4", "DDR5"],
    ),
]

_ATTRIBUTES_BY_GROUP: dict[str, list[tuple]] = {
    # Процессоры — раздел 5.2 ТЗ
    "cpu": [
        (
            "cpu.socket",
            "Сокет",
            AttributeDataType.ENUM,
            None,
            FilterWidget.CHECKBOX,
            10,
            True,
            ["AM5", "AM4", "LGA1700", "LGA1851"],
        ),
        ("cpu.cores", "Ядра", AttributeDataType.NUMBER, "шт", FilterWidget.RANGE, 20, True, None),
        (
            "cpu.threads",
            "Потоки",
            AttributeDataType.NUMBER,
            "шт",
            FilterWidget.RANGE,
            30,
            True,
            None,
        ),
        (
            "cpu.base_clock",
            "Базовая частота",
            AttributeDataType.NUMBER,
            "ГГц",
            None,
            40,
            True,
            None,
        ),
        (
            "cpu.max_clock",
            "Максимальная частота",
            AttributeDataType.NUMBER,
            "ГГц",
            None,
            50,
            True,
            None,
        ),
        (
            "cpu.tdp",
            "Тепловыделение",
            AttributeDataType.NUMBER,
            "Вт",
            FilterWidget.RANGE,
            60,
            True,
            None,
        ),
        (
            "cpu.architecture",
            "Архитектура",
            AttributeDataType.ENUM,
            None,
            FilterWidget.SELECT,
            70,
            True,
            ["Zen 3", "Zen 4", "Zen 5", "Core 13-е поколение", "Core Ultra"],
        ),
        (
            "cpu.integrated_graphics",
            "Встроенная графика",
            AttributeDataType.BOOL,
            None,
            None,
            80,
            True,
            None,
        ),
    ],
    # Видеокарты
    "gpu": [
        (
            "gpu.memory_size",
            "Объём видеопамяти",
            AttributeDataType.NUMBER,
            "ГБ",
            FilterWidget.RANGE,
            10,
            True,
            None,
        ),
        (
            "gpu.memory_type",
            "Тип видеопамяти",
            AttributeDataType.ENUM,
            None,
            FilterWidget.CHECKBOX,
            20,
            True,
            ["GDDR6", "GDDR6X", "GDDR7"],
        ),
        ("gpu.clock", "Частота GPU", AttributeDataType.NUMBER, "МГц", None, 30, True, None),
        ("gpu.fans", "Вентиляторы", AttributeDataType.NUMBER, "шт", None, 40, True, None),
        ("gpu.length", "Длина", AttributeDataType.NUMBER, "мм", None, 50, True, None),
        (
            "gpu.recommended_psu",
            "Рекомендуемый БП",
            AttributeDataType.NUMBER,
            "Вт",
            FilterWidget.RANGE,
            60,
            True,
            None,
        ),
        (
            "gpu.interface",
            "Интерфейс",
            AttributeDataType.ENUM,
            None,
            FilterWidget.SELECT,
            70,
            True,
            ["PCIe 4.0", "PCIe 5.0"],
        ),
    ],
    # SSD и HDD
    "storage": [
        (
            "storage.type",
            "Тип накопителя",
            AttributeDataType.ENUM,
            None,
            FilterWidget.SELECT,
            10,
            True,
            ["SSD", "HDD"],
        ),
        (
            "storage.form_factor",
            "Форм-фактор",
            AttributeDataType.ENUM,
            None,
            FilterWidget.CHECKBOX,
            20,
            True,
            ["M.2 2280", '2.5"', '3.5"'],
        ),
        (
            "storage.interface",
            "Интерфейс",
            AttributeDataType.ENUM,
            None,
            FilterWidget.SELECT,
            30,
            True,
            ["PCIe 4.0 x4", "PCIe 5.0 x4", "SATA III"],
        ),
        (
            "storage.capacity",
            "Объём",
            AttributeDataType.NUMBER,
            "ГБ",
            FilterWidget.RANGE,
            40,
            True,
            None,
        ),
        (
            "storage.read_speed",
            "Скорость чтения",
            AttributeDataType.NUMBER,
            "МБ/с",
            None,
            50,
            True,
            None,
        ),
        (
            "storage.write_speed",
            "Скорость записи",
            AttributeDataType.NUMBER,
            "МБ/с",
            None,
            60,
            True,
            None,
        ),
        (
            "storage.nand",
            "Тип памяти",
            AttributeDataType.ENUM,
            None,
            FilterWidget.SELECT,
            70,
            True,
            ["3D NAND TLC", "3D NAND QLC", "V-NAND"],
        ),
        ("storage.tbw", "Ресурс TBW", AttributeDataType.NUMBER, "ТБ", None, 80, True, None),
        ("storage.radiator", "Радиатор", AttributeDataType.BOOL, None, None, 90, True, None),
    ],
    # Оперативная память
    "ram": [
        (
            "ram.module_size",
            "Объём модуля",
            AttributeDataType.NUMBER,
            "ГБ",
            FilterWidget.RANGE,
            10,
            True,
            None,
        ),
        (
            "ram.total_size",
            "Общий объём",
            AttributeDataType.NUMBER,
            "ГБ",
            FilterWidget.SELECT,
            20,
            True,
            None,
        ),
        (
            "ram.modules",
            "Количество модулей",
            AttributeDataType.NUMBER,
            "шт",
            FilterWidget.SELECT,
            30,
            True,
            None,
        ),
        (
            "ram.clock",
            "Частота",
            AttributeDataType.NUMBER,
            "МГц",
            FilterWidget.RANGE,
            40,
            True,
            None,
        ),
        ("ram.timings", "Тайминги", AttributeDataType.TEXT, None, None, 50, True, None),
        (
            "ram.form_factor",
            "Форм-фактор",
            AttributeDataType.ENUM,
            None,
            FilterWidget.SELECT,
            60,
            True,
            ["DIMM", "SO-DIMM"],
        ),
    ],
    # Материнские платы
    "mb": [
        (
            "mb.socket",
            "Сокет",
            AttributeDataType.ENUM,
            None,
            FilterWidget.CHECKBOX,
            10,
            True,
            ["AM5", "AM4", "LGA1700", "LGA1851"],
        ),
        (
            "mb.chipset",
            "Чипсет",
            AttributeDataType.ENUM,
            None,
            FilterWidget.SELECT,
            20,
            True,
            ["B650", "X670E", "B760", "Z790", "B550", "X570"],
        ),
        (
            "mb.form_factor",
            "Форм-фактор",
            AttributeDataType.ENUM,
            None,
            FilterWidget.SELECT,
            30,
            True,
            ["ATX", "Micro-ATX", "Mini-ITX", "E-ATX"],
        ),
        ("mb.memory_slots", "Слоты памяти", AttributeDataType.NUMBER, "шт", None, 40, True, None),
        ("mb.max_memory", "Максимум памяти", AttributeDataType.NUMBER, "ГБ", None, 50, True, None),
        ("mb.m2_slots", "Слоты M.2", AttributeDataType.NUMBER, "шт", None, 60, True, None),
    ],
    # Блоки питания
    "psu": [
        (
            "psu.power",
            "Мощность",
            AttributeDataType.NUMBER,
            "Вт",
            FilterWidget.RANGE,
            10,
            True,
            None,
        ),
        (
            "psu.efficiency",
            "КПД",
            AttributeDataType.ENUM,
            None,
            FilterWidget.SELECT,
            20,
            True,
            ["80+ Bronze", "80+ Gold", "80+ Platinum", "80+ Titanium"],
        ),
        ("psu.modular", "Модульный", AttributeDataType.BOOL, None, None, 30, True, None),
    ],
    # Корпуса
    "case": [
        (
            "case.form_factor",
            "Форм-фактор",
            AttributeDataType.ENUM,
            None,
            FilterWidget.CHECKBOX,
            10,
            True,
            ["ATX", "Micro-ATX", "Mini-ITX"],
        ),
        (
            "case.side_panel",
            "Боковая панель",
            AttributeDataType.ENUM,
            None,
            FilterWidget.SELECT,
            20,
            True,
            ["Стекло", "Металл", "Акрил"],
        ),
        (
            "case.fans",
            "Вентиляторы в комплекте",
            AttributeDataType.NUMBER,
            "шт",
            None,
            30,
            True,
            None,
        ),
    ],
    # Системы охлаждения
    "cooling": [
        (
            "cooling.type",
            "Тип охлаждения",
            AttributeDataType.ENUM,
            None,
            FilterWidget.SELECT,
            10,
            True,
            ["Воздушное", "Жидкостное"],
        ),
        (
            "cooling.sockets",
            "Совместимые сокеты",
            AttributeDataType.ENUM,
            None,
            FilterWidget.CHECKBOX,
            20,
            True,
            ["AM5", "AM4", "LGA1700", "LGA1851"],
        ),
        ("cooling.height", "Высота", AttributeDataType.NUMBER, "мм", None, 30, True, None),
        ("cooling.radiator", "Радиатор", AttributeDataType.NUMBER, "мм", None, 40, True, None),
        ("cooling.fans", "Вентиляторы", AttributeDataType.NUMBER, "шт", None, 50, True, None),
    ],
    # Мониторы
    "monitor": [
        (
            "monitor.diagonal",
            "Диагональ",
            AttributeDataType.NUMBER,
            "дюйм",
            FilterWidget.RANGE,
            10,
            True,
            None,
        ),
        (
            "monitor.resolution",
            "Разрешение",
            AttributeDataType.ENUM,
            None,
            FilterWidget.CHECKBOX,
            20,
            True,
            ["1920×1080", "2560×1440", "3840×2160"],
        ),
        (
            "monitor.refresh",
            "Частота обновления",
            AttributeDataType.NUMBER,
            "Гц",
            FilterWidget.RANGE,
            30,
            True,
            None,
        ),
        (
            "monitor.panel",
            "Матрица",
            AttributeDataType.ENUM,
            None,
            FilterWidget.SELECT,
            40,
            True,
            ["IPS", "VA", "OLED"],
        ),
    ],
    # Периферия
    "peripheral": [
        (
            "peripheral.type",
            "Тип",
            AttributeDataType.ENUM,
            None,
            FilterWidget.SELECT,
            10,
            True,
            ["Клавиатура", "Мышь", "Гарнитура", "Кабель"],
        ),
        (
            "peripheral.connection",
            "Подключение",
            AttributeDataType.ENUM,
            None,
            FilterWidget.SELECT,
            20,
            True,
            ["Проводное", "Беспроводное"],
        ),
        (
            "peripheral.switch_type",
            "Переключатели",
            AttributeDataType.ENUM,
            None,
            FilterWidget.SELECT,
            30,
            True,
            ["Механические", "Оптомеханические", "Мембранные"],
        ),
        ("peripheral.backlight", "Подсветка", AttributeDataType.BOOL, None, None, 40, True, None),
    ],
}

# Плоский список для импорта — порядок групп совпадает с порядком на сайте.
ATTRIBUTES: list[tuple] = [
    *_ATTRIBUTES_COMMON,
    *[
        item
        for group in (
            "cpu",
            "gpu",
            "storage",
            "ram",
            "mb",
            "psu",
            "case",
            "cooling",
            "monitor",
            "peripheral",
        )
        for item in _ATTRIBUTES_BY_GROUP[group]
    ],
]

# Какие характеристики относятся к каким категориям.
CATEGORY_ATTRIBUTES: dict[str, list[str]] = {
    "processory": ["common.warranty", "cpu.*"],
    "videokarty": ["common.warranty", "gpu.*"],
    "materialskie-platy": ["common.warranty", "mb.*", "common.memory_type"],
    "operativnaya-pamyat": ["common.warranty", "ram.*", "common.memory_type"],
    "ssd": ["common.warranty", "storage.*"],
    "hdd": ["common.warranty", "storage.type", "storage.interface", "storage.capacity"],
    "bloki-pitaniya": ["common.warranty", "psu.*"],
    "korpusa": ["common.warranty", "case.*"],
    "sistemy-ohlazhdeniya": ["common.warranty", "cooling.*"],
    "monitory": ["common.warranty", "monitor.*"],
    "klaviatury": ["common.warranty", "peripheral.*"],
    "myshi": ["common.warranty", "peripheral.*"],
    "garnitury": ["common.warranty", "peripheral.*"],
    "kabely-i-aksessuary": ["common.warranty", "peripheral.*"],
}

BRANDS: list[tuple[str, str]] = [
    ("AMD", "amd"),
    ("Intel", "intel"),
    ("NVIDIA", "nvidia"),
    ("ASUS", "asus"),
    ("MSI", "msi"),
    ("Gigabyte", "gigabyte"),
    ("Samsung", "samsung"),
    ("Kingston", "kingston"),
    ("Crucial", "crucial"),
    ("Corsair", "corsair"),
    ("DeepCool", "deepcool"),
    ("Acer", "acer"),
    ("Logitech", "logitech"),
    ("HyperX", "hyperx"),
    ("WD", "wd"),
    ("Seagate", "seagate"),
]

CATEGORIES: list[tuple[str, str, str | None, int]] = [
    ("Комплектующие", "komplektuyushchie", None, 0),
    ("Процессоры", "processory", "komplektuyushchie", 1),
    ("Видеокарты", "videokarty", "komplektuyushchie", 1),
    ("Материнские платы", "materialskie-platy", "komplektuyushchie", 1),
    ("Оперативная память", "operativnaya-pamyat", "komplektuyushchie", 1),
    ("SSD", "ssd", "komplektuyushchie", 1),
    ("HDD", "hdd", "komplektuyushchie", 1),
    ("Блоки питания", "bloki-pitaniya", "komplektuyushchie", 1),
    ("Корпуса", "korpusa", "komplektuyushchie", 1),
    ("Системы охлаждения", "sistemy-ohlazhdeniya", "komplektuyushchie", 1),
    ("Мониторы", "monitory", "komplektuyushchie", 1),
    ("Клавиатуры", "klaviatury", "komplektuyushchie", 1),
    ("Мыши", "myshi", "komplektuyushchie", 1),
    ("Гарнитуры", "garnitury", "komplektuyushchie", 1),
    ("Кабели и аксессуары", "kabely-i-aksessuary", "komplektuyushchie", 1),
]

BANNERS: list[tuple[str, str, str, str]] = [
    (
        "Собери мощный ПК",
        "Скидки до 20% на процессоры и видеокарты",
        "/catalog?has_discount=true",
        "Смотреть",
    ),
    ("Накопители со скидкой", "SSD до 4 ТБ от 7 990 ₽", "/catalog/ssd", "Перейти"),
    ("Гарантия и возврат", "Официальные поставки, 14 дней на возврат", "/delivery", "Условия"),
]


async def seed_attributes(session) -> dict[str, AttributeDef]:
    """Создаёт справочник характеристик. Возвращает карту ключ → запись."""
    existing = {
        attr.key: attr for attr in (await session.execute(select(AttributeDef))).scalars().all()
    }

    for key, name, data_type, unit, widget, sort_order, comparable, options in ATTRIBUTES:
        if key in existing:
            continue
        attribute = AttributeDef(
            key=key,
            name=name,
            data_type=data_type,
            unit=unit,
            filter_widget=widget,
            options=([{"value": value, "label": value} for value in options] if options else None),
            is_filterable=True,
            is_comparable=comparable,
            sort_order=sort_order,
        )
        session.add(attribute)
        await session.flush()
        existing[key] = attribute

    # Привязываем характеристики к категориям по маскам вида "cpu.*".
    categories = {c.slug: c for c in (await session.execute(select(Category))).scalars().all()}
    for slug, masks in CATEGORY_ATTRIBUTES.items():
        category = categories.get(slug)
        if category is None:
            continue
        for key, attribute in existing.items():
            if any(_matches(key, mask) for mask in masks):
                attribute.category_id = category.id
    await session.flush()
    return existing


def _matches(key: str, mask: str) -> bool:
    if mask.endswith(".*"):
        return key.startswith(mask[:-1])
    return key == mask


async def seed_structure(session, *, force: bool = False) -> dict[str, Category]:
    """Категории и бренды. Возвращает карту slug → категория."""
    if force:
        from app.models.catalog import ProductRelation

        await session.execute(ProductRelation.__table__.delete())
        await session.execute(ProductSpec.__table__.delete())
        await session.execute(Product.__table__.delete())
        await session.execute(AttributeDef.__table__.update().values(category_id=None))
        await session.execute(Banner.__table__.delete())
        await session.execute(Category.__table__.delete())
        await session.execute(Brand.__table__.delete())
        await session.flush()

    categories = {c.slug: c for c in (await session.execute(select(Category))).scalars().all()}
    for index, (name, slug, parent_slug, level) in enumerate(CATEGORIES):
        if slug in categories:
            continue
        category = Category(
            name=name,
            slug=slug,
            level=level,
            sort_order=index,
            parent_id=categories[parent_slug].id if parent_slug else None,
        )
        session.add(category)
        await session.flush()
        categories[slug] = category

    brands = {b.slug: b for b in (await session.execute(select(Brand))).scalars().all()}
    for name, slug in BRANDS:
        if slug not in brands:
            brand = Brand(name=name, slug=slug)
            session.add(brand)
            await session.flush()
            brands[slug] = brand

    for index, (title, subtitle, link, button) in enumerate(BANNERS):
        existing_banner = await session.execute(select(Banner).where(Banner.title == title))
        if existing_banner.scalar_one_or_none() is None:
            session.add(
                Banner(
                    title=title,
                    subtitle=subtitle,
                    link_url=link,
                    button_text=button,
                    sort_order=index,
                )
            )
    await session.flush()
    return categories


def money(value: str | int) -> Decimal:
    return Decimal(str(value))


def price_with_discount(base: str | int, percent: int) -> tuple[Decimal, Decimal]:
    """Цена со скидкой и старая цена.

    Новая цена округляется до целых рублей: розничные цены с копейками
    выглядят как ошибка округления, а скидку всё равно показывает процент.
    """
    old = money(base)
    new = (old * (100 - percent) / 100).quantize(Decimal("1"))
    return new, old


__all__ = [
    "ATTRIBUTES",
    "BANNERS",
    "BRANDS",
    "CATEGORIES",
    "CATEGORY_ATTRIBUTES",
    "money",
    "price_with_discount",
    "seed_attributes",
    "seed_structure",
]
