import { useState } from "react";

import type { Route } from "./+types/product";
import { describeApiError } from "~/lib/api-error";
import { ApiError, serverFetch } from "~/lib/api.server";
import type { ProductCard, ProductDetail } from "~/lib/catalog";
import { readAccessToken } from "~/lib/auth-token";
import { formatPrice, plural } from "~/lib/format";
import {
  AvailabilityBadge,
  ProductCardTile,
  ProductImageFrame,
  RatingRow,
} from "~/widgets/product-card";
import { AddToCartButton, FavoriteButton, unavailableHint } from "~/widgets/product-actions";
import { SiteHeader } from "~/widgets/site-header";
import { SiteFooter } from "~/widgets/site-footer";

export function meta({ data }: Route.MetaArgs): Route.MetaDescriptors {
  const product = data?.ok === true ? data.payload.product : null;
  return [
    { title: product ? `${product.name} — ПУЛЬС` : "Товар — ПУЛЬС" },
    {
      name: "description",
      content:
        product?.short_description ??
        "Характеристики, наличие и цена на комплектующие для ПК в интернет-магазине ПУЛЬС.",
    },
  ];
}

type ProductResponse = {
  product: ProductDetail;
  similar: ProductCard[];
  compatible: ProductCard[];
};

/**
 * Страница товара `/product/:slug`.
 *
 * Всё приходит одним запросом в loader: описание, галерея, характеристики и
 * обе связанные подборки. Клиентского fetch нет — во время SSR он не выполнился
 * бы, и страница осталась бы пустой.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const slug = params.slug ?? "";
  const authenticated = Boolean(readAccessToken(request));

  try {
    const payload = await serverFetch<ProductResponse>(
      `/products/${encodeURIComponent(slug)}`,
    );
    return { ok: true as const, authenticated, payload };
  } catch (cause) {
    // Товара нет — честный 404 для ErrorBoundary корневого маршрута.
    if (cause instanceof ApiError && cause.status === 404) {
      throw new Response("Товар не найден", { status: 404, statusText: "Товар не найден" });
    }
    return {
      ok: false as const,
      authenticated,
      error: describeApiError(cause, "Не удалось загрузить товар"),
    };
  }
}

/* ─────────────────────────── характеристики ───────────────────────────── */

/**
 * Заголовки групп характеристик по префиксу ключа.
 *
 * Ключи приходят точечными (`cpu.socket`, `cpu.cores`), и группировка по
 * префиксу ставит «Сокет» и «Ядра» рядом — иначе одинаковые названия вроде
 * «Тип памяти» повторялись бы для RAM и накопителей в одной таблице.
 */
const SPEC_GROUP_TITLES: Record<string, string> = {
  cpu: "Процессор",
  gpu: "Видеокарта",
  mb: "Материнская плата",
  ram: "Оперативная память",
  storage: "Накопитель",
  psu: "Блок питания",
  case: "Корпус",
  cooling: "Охлаждение",
  monitor: "Монитор",
  peripheral: "Периферия",
  common: "Общие характеристики",
};

const OTHER_GROUP_TITLE = "Прочие характеристики";

type SpecGroup = { title: string; rows: { key: string; name: string; value: string; unit: string | null }[] };

/**
 * Характеристики → группы. Порядок групп задаёт порядок самих спецификаций
 * (`sort_order`), а не алфавит: главное свойство товара должно быть первым.
 */
function groupSpecs(product: ProductDetail): SpecGroup[] {
  const sorted = [...product.specs].sort((a, b) => a.sort_order - b.sort_order);
  const groups = new Map<string, SpecGroup>();

  for (const spec of sorted) {
    const prefix = spec.key.includes(".") ? spec.key.split(".")[0] ?? "" : "";
    const title = SPEC_GROUP_TITLES[prefix] ?? OTHER_GROUP_TITLE;
    const group = groups.get(title) ?? { title, rows: [] };
    group.rows.push({ key: spec.key, name: spec.name, value: spec.value, unit: spec.unit });
    groups.set(title, group);
  }

  return [...groups.values()];
}

function SpecValue({ value, unit }: { value: string; unit: string | null }) {
  return (
    <span>
      {value}
      {unit ? <span className="text-slate-500"> {unit}</span> : null}
    </span>
  );
}

/* ───────────────────────────── галерея ───────────────────────────────── */

function Gallery({ product }: { product: ProductDetail }) {
  // Главное фото — первое: backend помечает его `is_main`, но порядок
  // sort_order надёжнее, если флаг не проставлен.
  const images = [...product.images].sort((a, b) => {
    if (a.is_main !== b.is_main) return a.is_main ? -1 : 1;
    return a.sort_order - b.sort_order;
  });

  const [active, setActive] = useState(0);
  const current = images[active] ?? null;

  return (
    <div>
      <div className="card overflow-hidden bg-slate-50 p-3 sm:p-4">
        {current ? (
          <img
            src={current.image_url}
            alt={current.alt ?? product.name}
            className="mx-auto aspect-square w-full max-w-md object-contain"
          />
        ) : (
          <ProductImageFrame product={product} size="hero" className="mx-auto max-w-md rounded-xl" />
        )}
      </div>

      {images.length > 1 ? (
        <ul className="mt-3 flex flex-wrap gap-2">
          {images.map((image, index) => (
            <li key={image.id}>
              <button
                type="button"
                onClick={() => setActive(index)}
                aria-current={index === active ? "true" : undefined}
                aria-label={`Показать фото ${index + 1} из ${images.length}`}
                className={`overflow-hidden rounded-xl border-2 bg-white transition-colors ${
                  index === active ? "border-pulse-600" : "border-slate-200 hover:border-slate-300"
                }`}
              >
                <img
                  src={image.image_url}
                  alt={image.alt ?? `${product.name}, фото ${index + 1}`}
                  loading="lazy"
                  className="h-16 w-16 object-cover sm:h-20 sm:w-20"
                />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* ────────────────────────── блоки информации ─────────────────────────── */

const INFO_BLOCKS = [
  {
    title: "Доставка",
    lines: [
      "По Москве и области — курьером, от 1 до 3 дней.",
      "По России — транспортными компаниями и СДЭК, 3–10 дней.",
      "Самовывоз из пункта выдачи — бесплатно, в день заказа.",
    ],
  },
  {
    title: "Оплата",
    lines: [
      "Банковская карта, СБП или онлайн-кошелёк.",
      "Для юридических лиц — безналичный расчёт по счёту.",
      "Оплата при получении доступна в пунктах выдачи.",
    ],
  },
  {
    title: "Возврат и гарантия",
    lines: [
      "14 дней на возврат без объяснения причи.",
      "Гарантия производителя — от 12 месяцев.",
      "Неисправный товар меняем или возвращаем деньги.",
    ],
  },
] as const;

export default function Product({ loaderData }: Route.ComponentProps) {
  const { authenticated } = loaderData;

  if (!loaderData.ok) {
    return (
      <div className="flex min-h-full flex-col">
        <SiteHeader authenticated={authenticated} />
        <main className="container-pulse flex-1 py-16 text-center">
          <div role="alert" className="card mx-auto max-w-lg border-rose-200 bg-rose-50 p-8">
            <p className="text-sm font-semibold text-rose-700">
              {loaderData.error.status > 0 ? `Ошибка ${loaderData.error.status}` : "Нет связи с сервером"}
            </p>
            <h1 className="mt-2 text-xl font-bold tracking-tight text-slate-900">
              Не удалось открыть товар
            </h1>
            <p className="mt-2 text-sm text-slate-700">{loaderData.error.message}</p>
            <a
              href="/catalog"
              className="mt-6 inline-block rounded-xl bg-pulse-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-pulse-700"
            >
              Вернуться в каталог
            </a>
          </div>
        </main>
        <SiteFooter />
      </div>
    );
  }

  const { product, similar, compatible } = loaderData.payload;
  const groups = groupSpecs(product);
  const hasDiscount = product.discount_percent > 0 && product.old_price !== null;

  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader authenticated={authenticated} />

      <main className="container-pulse flex-1 py-6 sm:py-10">
        <nav aria-label="Хлебные крошки" className="mb-4">
          <ol className="flex flex-wrap items-center gap-1 text-sm text-slate-500">
            <li>
              <a href="/" className="hover:text-pulse-700">
                Главная
              </a>
            </li>
            <li aria-hidden="true" className="text-slate-300">
              /
            </li>
            <li>
              <a href={`/catalog/${product.category.slug}`} className="hover:text-pulse-700">
                {product.category.name}
              </a>
            </li>
            <li aria-hidden="true" className="text-slate-300">
              /
            </li>
            <li>
              <span aria-current="page" className="font-medium text-slate-800">
                {product.name}
              </span>
            </li>
          </ol>
        </nav>

        <div className="grid gap-6 lg:grid-cols-2 lg:gap-10">
          <Gallery product={product} />

          <section aria-label="Карточка товара">
            {product.brand ? (
              <a
                href={`/catalog?brand=${encodeURIComponent(product.brand.slug)}`}
                className="text-sm font-semibold tracking-wide text-pulse-700 uppercase hover:text-pulse-800"
              >
                {product.brand.name}
              </a>
            ) : null}

            <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
              {product.name}
            </h1>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <RatingRow product={product} />
              {product.sku ? (
                <span className="text-xs text-slate-400">
                  Артикул: <span className="text-slate-600">{product.sku}</span>
                </span>
              ) : null}
            </div>

            <div className="card mt-5 p-5">
              <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
                <span className="text-3xl font-bold tracking-tight text-slate-900">
                  {formatPrice(product.price)}
                </span>
                {hasDiscount ? (
                  <>
                    <span className="text-lg text-slate-400 line-through">
                      {formatPrice(product.old_price)}
                    </span>
                    <span className="rounded-lg bg-rose-600 px-2 py-0.5 text-sm font-bold text-white">
                      −{product.discount_percent}%
                    </span>
                  </>
                ) : null}
              </div>

              {/* Закупочная цена приходит только сотруднику: гостю поле null,
                  и показывать его незачем — поэтому условие, а не «0 ₽». */}
              {product.purchase_price !== null ? (
                <p className="mt-2 text-sm text-slate-500">
                  Закупочная цена:{" "}
                  <span className="font-medium text-slate-700">
                    {formatPrice(product.purchase_price)}
                  </span>
                </p>
              ) : null}

              <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
                <AvailabilityBadge
                  availability={product.availability}
                  quantity={product.available_quantity}
                  className="text-sm"
                />
                <span className="text-sm text-slate-500">
                  Гарантия {product.warranty_months}{" "}
                  {plural(product.warranty_months, "месяц", "месяца", "месяцев")}
                </span>
              </div>

              <div className="mt-5 grid gap-2 sm:grid-cols-2">
                <AddToCartButton
                  productId={product.id}
                  productName={product.name}
                  disabled={product.availability === "out_of_stock" || product.availability === "discontinued"}
                />
                <FavoriteButton productId={product.id} productName={product.name} />
              </div>
              {unavailableHint(product.availability) ? (
                <p className="mt-2 text-xs text-slate-500">{unavailableHint(product.availability)}</p>
              ) : null}

              {/*
                Ссылка сравнения собирается из id этого товара: второй товар
                пользователь добавит, перейдя на его страницу или дописав id в
                адрес. Так «сравнить» работает без отдельного состояния выбора.
              */}
              <a
                href={`/compare?ids=${product.id}`}
                className="mt-2 block rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-center text-sm font-semibold text-slate-700 transition-colors hover:border-pulse-400 hover:text-pulse-700"
              >
                Сравнить
              </a>
            </div>

            {product.short_description ? (
              <p className="mt-5 text-base leading-relaxed text-slate-700">
                {product.short_description}
              </p>
            ) : null}
          </section>
        </div>

        {product.description ? (
          <section aria-label="Описание" className="card mt-8 p-6">
            <h2 className="text-lg font-semibold text-slate-900">Описание</h2>
            <p className="mt-3 leading-relaxed whitespace-pre-line text-slate-700">
              {product.description}
            </p>
          </section>
        ) : null}

        {groups.length > 0 ? (
          <section aria-label="Характеристики" className="mt-8">
            <h2 className="text-xl font-bold tracking-tight text-slate-900">Характеристики</h2>
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              {groups.map((group) => (
                <div key={group.title} className="card overflow-hidden">
                  <h3 className="border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-semibold text-slate-900">
                    {group.title}
                  </h3>
                  <dl className="divide-y divide-slate-100">
                    {group.rows.map((row) => (
                      <div
                        key={row.key}
                        className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-2.5"
                      >
                        <dt className="text-sm text-slate-600">{row.name}</dt>
                        <dd className="text-right text-sm font-medium text-slate-900">
                          <SpecValue value={row.value} unit={row.unit} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section aria-label="Условия покупки" className="mt-8">
          <div className="grid gap-4 sm:grid-cols-3">
            {INFO_BLOCKS.map((block) => (
              <div key={block.title} className="card p-5">
                <h2 className="text-base font-semibold text-slate-900">{block.title}</h2>
                <ul className="mt-2.5 space-y-1.5">
                  {block.lines.map((line) => (
                    <li key={line} className="flex gap-2 text-sm text-slate-600">
                      <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-pulse-400" />
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {similar.length > 0 ? (
          <section aria-label="Похожие товары" className="mt-10">
            <h2 className="text-xl font-bold tracking-tight text-slate-900">Похожие товары</h2>
            <p className="mt-1 text-sm text-slate-600">
              Товары той же категории с похожим набором характеристик.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {similar.map((item) => (
                <ProductCardTile key={item.id} product={item} size="xs" />
              ))}
            </div>
          </section>
        ) : null}

        {compatible.length > 0 ? (
          <section aria-label="Совместимые товары" className="mt-10">
            <h2 className="text-xl font-bold tracking-tight text-slate-900">Совместимые товары</h2>
            <p className="mt-1 text-sm text-slate-600">
              Подходят вместе с этим товаром при сборке системы.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {compatible.map((item) => (
                <ProductCardTile key={item.id} product={item} size="xs" />
              ))}
            </div>
          </section>
        ) : null}
      </main>
      <SiteFooter />
    </div>
  );
}
