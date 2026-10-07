"""Служебные команды: python -m app.cli <команда>.

Полезно в двух случаях:

* выдать первую роль администратора — единственный путь, потому что
  публичной регистрацией роль всегда ``customer``;
* загрузить демо-данные на стенд.
"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import logging
import sys
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy import func, select

from app.core.logging import configure_logging
from app.db.session import session_scope
from app.models.catalog import Brand, Category, Product, ProductSpec
from app.models.enums import AttributeDataType, ProductStatus, UserRole
from app.models.user import User
from app.services.auth import create_admin_account

logger = logging.getLogger(__name__)


async def cmd_create_admin(args: argparse.Namespace) -> int:
    password = args.password or getpass.getpass("Пароль администратора: ")
    if len(password) < 8:
        print("Пароль короче 8 символов — не подходит (раздел 5.7 ТЗ).", file=sys.stderr)
        return 1

    async with session_scope() as session:
        try:
            user = await create_admin_account(
                session,
                email=args.email,
                password=password,
                first_name=args.first_name,
                last_name=args.last_name,
            )
        except Exception as exc:  # noqa: BLE001 — CLI должен показать текст, а не трейсбек
            print(f"Не удалось создать администратора: {exc}", file=sys.stderr)
            return 1
        print(f"Создан администратор {user.email} (id={user.id})")
    return 0


async def cmd_create_user(args: argparse.Namespace) -> int:
    """Создание тестовой учётной записи любой роли (раздел 19 ТЗ)."""
    from app.core.security import hash_password
    from app.repositories.user import UserRepository

    async with session_scope() as session:
        users = UserRepository(session)
        if await users.email_exists(args.email):
            print(f"Пользователь {args.email} уже существует.")
            return 0
        user = User(
            email=args.email.lower(),
            password_hash=hash_password(args.password),
            first_name=args.first_name,
            last_name=args.last_name,
            role=UserRole(args.role),
            email_verified=True,
            is_active=True,
        )
        await users.add(user)
        print(f"Создан {args.role}: {user.email} (id={user.id})")
    return 0


async def cmd_seed(args: argparse.Namespace) -> int:
    """Минимальный набор категорий и брендов.

    Товары наполняются на этапе 3 вместе с импортом: заводить их сейчас
    незачем — через неделю схема каталога изменится под фильтры.
    """
    async with session_scope() as session:
        existing = await session.execute(select(func.count()).select_from(Category))
        if (existing.scalar_one() or 0) > 0 and not args.force:
            print("Категории уже загружены. Используйте --force, чтобы добавить заново.")
            return 0

        root = Category(name="Комплектующие", slug="komplektuyushchie", level=0, sort_order=0)
        session.add(root)
        await session.flush()

        subcategories = [
            ("Процессоры", "processory"),
            ("Видеокарты", "videokarty"),
            ("Материнские платы", "materialskie-platy"),
            ("Оперативная память", "operativnaya-pamyat"),
            ("SSD", "ssd"),
            ("HDD", "hdd"),
            ("Блоки питания", "bloki-pitaniya"),
            ("Корпуса", "korpusa"),
            ("Системы охлаждения", "sistemy-ohlazhdeniya"),
            ("Мониторы", "monitory"),
            ("Клавиатуры", "klaviatury"),
            ("Мыши", "myshi"),
            ("Гарнитуры", "garnitury"),
            ("Кабели и аксессуары", "kabely-i-aksessuary"),
        ]
        for index, (name, slug) in enumerate(subcategories, start=1):
            session.add(
                Category(
                    parent_id=root.id,
                    name=name,
                    slug=slug,
                    level=1,
                    sort_order=index,
                )
            )

        for brand_name in (
            "AMD",
            "Intel",
            "NVIDIA",
            "ASUS",
            "MSI",
            "Gigabyte",
            "Samsung",
            "Kingston",
        ):
            session.add(Brand(name=brand_name, slug=brand_name.lower()))
        await session.flush()

        print(f"Загружено: 1 корневая категория, {len(subcategories)} подкатегорий, 8 брендов.")
    return 0


async def cmd_seed_catalog(args: argparse.Namespace) -> int:
    """Наполняет каталог: структура, справочник характеристик, товары.

    Идемпотентна: повторный запуск без ``--force`` не создаёт дубликаты,
    а обновляет цены и остатки уже существующих товаров.
    """
    from app.seed_data.catalog_seed import seed_attributes, seed_structure
    from app.seed_data.products_seed import PRODUCTS

    async with session_scope() as session:
        categories = await seed_structure(session, force=args.force)
        attributes = await seed_attributes(session)

        # Ключи словаря — и slug, и название в нижнем регистре: в данных сида
        # бренд задан как «AMD», а в таблице он лежит со slug «amd». Ища только
        # по slug, мы молча пропустили бы все 36 товаров.
        brands: dict[str, Brand] = {}
        for brand in (await session.execute(select(Brand))).scalars().all():
            brands[brand.slug] = brand
            brands[brand.name.lower()] = brand
        existing = {p.sku: p for p in (await session.execute(select(Product))).scalars().all()}

        created = 0
        updated = 0
        skipped: list[str] = []

        for seed in PRODUCTS:
            category = categories.get(seed.category)
            # Ключ ищется в нижнем регистре: в сиде бренд записан как «DeepCool»,
            # а в справочнике ключи приведены к нижнему регистру, иначе ни одна
            # из 36 позиций не нашла бы своего бренда.
            brand = brands.get(seed.brand.lower())
            if category is None or brand is None:
                skipped.append(f"{seed.sku}: нет категории «{seed.category}» или бренда")
                continue

            price = Decimal(seed.price)
            old_price = Decimal(seed.old_price) if seed.old_price else None
            created_at = datetime.now(UTC) - timedelta(days=seed.created_days_ago)

            product = existing.get(seed.sku)
            if product is None:
                product = Product(
                    slug=_slugify(seed.name),
                    sku=seed.sku,
                    name=seed.name,
                    model=seed.name.split(" ", 2)[-1] if len(seed.name.split()) > 2 else None,
                    short_description=seed.description,
                    description=seed.description,
                    category_id=category.id,
                    brand_id=brand.id,
                    price=price,
                    old_price=old_price,
                    purchase_price=(price * Decimal("0.82")).quantize(Decimal("0.01")),
                    stock_quantity=seed.stock,
                    reserved_quantity=0,
                    status=ProductStatus(seed.status),
                    warranty_months=seed.warranty,
                    weight=Decimal(seed.weight) if seed.weight else None,
                    rating_avg=Decimal(seed.rating),
                    rating_count=seed.reviews,
                    sales_count=seed.sales,
                    is_active=True,
                )
                session.add(product)
                await session.flush()
                created += 1
            else:
                product.price = price
                product.old_price = old_price
                product.stock_quantity = seed.stock
                product.status = ProductStatus(seed.status)
                product.rating_avg = Decimal(seed.rating)
                product.rating_count = seed.reviews
                product.sales_count = seed.sales
                updated += 1

            # created_at задаётся вручную: наполнение демо-данных должно
            # давать осмысленную «новизну», а не дату запуска сида.
            await session.execute(
                Product.__table__.update()
                .where(Product.id == product.id)
                .values(created_at=created_at)
            )

            for key, value in seed.specs.items():
                attribute = attributes.get(key)
                if attribute is None:
                    skipped.append(f"{seed.sku}: характеристика «{key}» не найдена")
                    continue
                await _set_spec(session, product.id, attribute, value)

        await session.flush()

        print(
            f"Каталог готов: категорий {len(categories)}, "
            f"характеристик {len(attributes)}, товаров {len(PRODUCTS)} "
            f"(создано {created}, обновлено {updated})"
        )
        for message in skipped:
            print(f"  пропущено: {message}", file=sys.stderr)
    return 0


async def _set_spec(session, product_id, attribute, value) -> None:
    """Записывает значение характеристики, разбирая его по типу.

    Тип определяется справочником, а не видом значения: строка «16» в
    характеристике с числовым типом должна лечь в ``value_num``, иначе по
    ней нельзя построить диапазонный фильтр.
    """
    statement = select(ProductSpec).where(
        ProductSpec.product_id == product_id,
        ProductSpec.attribute_id == attribute.id,
    )
    spec = (await session.execute(statement)).scalar_one_or_none()

    numeric: Decimal | None = None
    text_value: str | None = None
    bool_value: bool | None = None

    if attribute.data_type is AttributeDataType.NUMBER:
        numeric = Decimal(str(value))
    elif attribute.data_type is AttributeDataType.BOOL:
        bool_value = bool(value)
    else:
        text_value = str(value)

    if spec is None:
        session.add(
            ProductSpec(
                product_id=product_id,
                attribute_id=attribute.id,
                value_num=numeric,
                value_text=text_value,
                value_bool=bool_value,
                sort_order=attribute.sort_order,
            )
        )
        await session.flush()
        return

    spec.value_num = numeric
    spec.value_text = text_value
    spec.value_bool = bool_value


def _slugify(value: str) -> str:
    """Человекочитаемый URL из названия (раздел 11 ТЗ).

    Транслитерация сделана вручную: библиотека ради двадцати букв тянет
    лишнюю зависимость в продакшен-образ.
    """
    table = str.maketrans(
        {
            "а": "a",
            "б": "b",
            "в": "v",
            "г": "g",
            "д": "d",
            "е": "e",
            "ё": "e",
            "ж": "zh",
            "з": "z",
            "и": "i",
            "й": "y",
            "к": "k",
            "л": "l",
            "м": "m",
            "н": "n",
            "о": "o",
            "п": "p",
            "р": "r",
            "с": "s",
            "т": "t",
            "у": "u",
            "ф": "f",
            "х": "h",
            "ц": "c",
            "ч": "ch",
            "ш": "sh",
            "щ": "sch",
            "ъ": "",
            "ы": "y",
            "ь": "",
            "э": "e",
            "ю": "yu",
            "я": "ya",
        }
    )
    translit = value.lower().translate(table)
    slug = "".join(ch if ch.isalnum() or ch in " -" else " " for ch in translit)
    slug = "-".join(slug.split())
    # Ограничение PostgreSQL на длину имени индекса при очень длинных
    # названиях — обрезаем с разрывом по слову.
    return slug[:180].rstrip("-")


async def cmd_release_reservations(args: argparse.Namespace) -> int:
    """Снимает брони заказов, которые не оплатили в срок (раздел 5.8).

    Без этого резерв на неоплаченный заказ держал бы товар заблокированным
    навсегда. В продакшене команду запускает планировщик (cron раз в час),
    здесь — вручную.
    """
    from app.services.orders import release_expired_reservations

    async with session_scope() as session:
        released = await release_expired_reservations(session)
    print(f"Снято просроченных резервов: {released}")
    return 0


async def cmd_list_users(args: argparse.Namespace) -> int:
    async with session_scope() as session:
        result = await session.execute(select(User).order_by(User.created_at))
        for user in result.scalars().all():
            status = "активен" if user.is_active else "заблокирован"
            verified = "email подтверждён" if user.email_verified else "email не подтверждён"
            print(f"{user.email:35} {user.role.value:9} {status:11} {verified}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="app.cli", description="Служебные команды ПУЛЬС")
    sub = parser.add_subparsers(dest="command", required=True)

    admin = sub.add_parser("create-admin", help="Создать администратора")
    admin.add_argument("--email", required=True)
    admin.add_argument("--first-name", default="Администратор")
    admin.add_argument("--last-name", default="Магазина")
    admin.add_argument("--password", default=None, help="Не передавать — спросит интерактивно")
    admin.set_defaults(func=cmd_create_admin)

    user = sub.add_parser("create-user", help="Создать пользователя заданной роли")
    user.add_argument("--email", required=True)
    user.add_argument("--password", required=True)
    user.add_argument("--role", default="customer", choices=[r.value for r in UserRole])
    user.add_argument("--first-name", default="Тест")
    user.add_argument("--last-name", default="Пользователь")
    user.set_defaults(func=cmd_create_user)

    seed = sub.add_parser("seed", help="Загрузить базовые категории и бренды")
    seed.add_argument("--force", action="store_true")
    seed.set_defaults(func=cmd_seed)

    catalog_seed = sub.add_parser(
        "seed-catalog",
        help="Наполнить каталог: категории, характеристики, товары",
    )
    catalog_seed.add_argument(
        "--force",
        action="store_true",
        help="Удалить товары и пересоздать структуру перед загрузкой",
    )
    catalog_seed.set_defaults(func=cmd_seed_catalog)

    listing = sub.add_parser("list-users", help="Показать всех пользователей")
    listing.set_defaults(func=cmd_list_users)

    reservations = sub.add_parser(
        "release-reservations",
        help="Снять брони заказов, не оплаченных в срок",
    )
    reservations.set_defaults(func=cmd_release_reservations)

    return parser


def main(argv: list[str] | None = None) -> int:
    configure_logging()
    args = build_parser().parse_args(argv)
    return asyncio.run(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
