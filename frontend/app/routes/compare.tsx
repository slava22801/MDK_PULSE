import type { Route } from "./+types/compare";

import type { ProductCard } from "~/lib/catalog";
import { describeApiError } from "~/lib/api-error";
import { serverFetch } from "~/lib/api.server";
import { readAccessToken } from "~/lib/auth-token";
import { formatPrice, plural } from "~/lib/format";
import { AvailabilityBadge, ProductImageFrame } from "~/widgets/product-card";
import { AddToCartButton, FavoriteButton } from "~/widgets/product-actions";
import { SiteHeader } from "~/widgets/site-header";
import { SiteFooter } from "~/widgets/site-footer";

export function meta({ data }: Route.MetaArgs): Route.MetaDescriptors {
  const name = data && "payload" in data && data.payload ? data.payload.category.name : "Сравнение";
  return [
    { title: `Сравнение: ${name} — ПУЛЬС` },
    { name: "description", content: "Сравнение характеристик комплектующих по ключевым параметрам." },
  ];
}

/** Товар в колонке таблицы: карточка плюс его характеристики. */
type CompareProduct = ProductCard & {
  specs: Record<string, string>;
  differs: string[];
};

type CompareAttribute = {
  key: string;
  name: string;
  unit: string | null;
  values: (string | null)[];
  is_different: boolean;
};

type CompareResponse = {
  category: { id: string; name: string; slug: string; level: number };
  products: CompareProduct[];
  attributes: CompareAttribute[];
  identical_count: number;
  different_count: number;
};

/** Больше четырёх товаров backend не сравнивает (раздел 5.5 ТЗ). */
const MAX_COMPARE = 4;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Идентификаторы сравниваемых товаров живут в query-строке (`?ids=a,b,c`).
 *
 * Это делает сравнение ссылкой: её можно отправить другу, положить в закладки
 * и вернуться к ней после перезагрузки. Разбор идёт здесь, а не в компоненте,
 * чтобы loader и разметка смотрели на один и тот же набор.
 */
function parseIds(search: URLSearchParams): string[] {
  const raw = search.get("ids") ?? "";
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const value = part.trim();
    // Мусор в URL отсекаем сами: иначе пользователь получил бы 422 от
    // backend-а из-за ссылки, которую скопировал и дополнил вручную.
    if (!UUID_RE.test(value)) continue;
    seen.add(value);
  }
  return [...seen].slice(0, MAX_COMPARE);
}

/**
 * Сравнение `/compare`.
 *
 * Сравнение не требует авторизации (проверено живым запросом), поэтому loader
 * не требует токен. `POST /compare` — единственный способ получить таблицу,
 * так как GET-варианта на backend-е нет.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const ids = parseIds(url.searchParams);
  const onlyDifferent = url.searchParams.get("only") === "diff";
  const authenticated = Boolean(readAccessToken(request));

  if (ids.length < 2) {
    return { ok: true as const, state: "need-ids" as const, authenticated, ids, onlyDifferent };
  }

  try {
    const payload = await serverFetch<CompareResponse>("/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_ids: ids }),
    });
    return { ok: true as const, state: "ready" as const, authenticated, ids, onlyDifferent, payload };
  } catch (cause) {
    return {
      ok: false as const,
      state: "error" as const,
      authenticated,
      ids,
      onlyDifferent,
      error: describeApiError(cause, "Не удалось сравнить товары"),
    };
  }
}

/** Ссылка на ту же выборку с другим режимом показа — чтобы не терять URL. */
function hrefWithOnly(ids: readonly string[], onlyDifferent: boolean): string {
  const search = new URLSearchParams();
  search.set("ids", ids.join(","));
  if (onlyDifferent) search.set("only", "diff");
  return `/compare?${search.toString()}`;
}

/* ─────────────────────────────── таблица ───────────────────────────────── */

function CompareTable({
  payload,
  onlyDifferent,
}: {
  payload: CompareResponse;
  onlyDifferent: boolean;
}) {
  // «Только отличающиеся» — фильтр на стороне отображения: данные те же, но
  // совпадающие строки прячутся. Их счётчик backend уже посчитал.
  const attributes = onlyDifferent
    ? payload.attributes.filter((attribute) => attribute.is_different)
    : payload.attributes;

  return (
    <div className="card overflow-x-auto">
      <table className="w-full min-w-[40rem] border-collapse text-sm">
        <caption className="sr-only">
          Сравнение товаров: строки — характеристики, столбцы — товары
        </caption>
        <thead>
          <tr>
            <th scope="col" className="w-40 border-b border-slate-200 bg-slate-50 px-3 py-3 text-left text-xs font-semibold text-slate-600 uppercase">
              Характеристика
            </th>
            {payload.products.map((product) => (
              <th
                key={product.id}
                scope="col"
                className="border-b border-l border-slate-200 bg-slate-50 px-3 py-3 text-left align-bottom font-normal"
              >
                <a
                  href={`/product/${product.slug}`}
                  className="block w-32 focus-visible:outline-offset-4 sm:w-40"
                >
                  <ProductImageFrame product={product} className="rounded-lg" />
                  <span className="sr-only">Изображение товара: {product.name}</span>
                </a>
                <a
                  href={`/product/${product.slug}`}
                  className="mt-2 block text-sm leading-snug font-semibold text-slate-900 hover:text-pulse-700"
                >
                  {product.name}
                </a>
                <span className="mt-1 block text-base font-bold text-slate-900">
                  {formatPrice(product.price)}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {attributes.length === 0 ? (
            <tr>
              <td
                colSpan={payload.products.length + 1}
                className="px-4 py-8 text-center text-sm text-slate-600"
              >
                Отличающихся характеристик нет — все товары совпадают.
              </td>
            </tr>
          ) : (
            attributes.map((attribute) => (
              <tr
                key={attribute.key}
                // Подсветка строки целиком: искать отличие в одной ячейке среди
                // одинаковых кусков таблицы неудобно.
                className={attribute.is_different ? "bg-amber-50/70" : ""}
              >
                <th scope="row" className="border-b border-slate-100 px-3 py-2.5 text-left text-sm font-medium text-slate-700">
                  {attribute.name}
                  {attribute.is_different ? (
                    <span className="ml-1.5 rounded bg-amber-200 px-1.5 py-0.5 text-[0.65rem] font-bold text-amber-900">
                      различается
                    </span>
                  ) : null}
                </th>
                {attribute.values.map((value, index) => (
                  <td
                    key={`${attribute.key}-${index}`}
                    className={`border-b border-l border-slate-100 px-3 py-2.5 text-slate-900 ${
                      attribute.is_different ? "font-semibold" : ""
                    }`}
                  >
                    {value && value !== "" ? value : "—"}
                    {value && attribute.unit ? (
                      <span className="text-slate-500"> {attribute.unit}</span>
                    ) : null}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ─────────────────────────────── страница ─────────────────────────────── */

export default function Compare({ loaderData }: Route.ComponentProps) {
  if (loaderData.state === "need-ids") {
    return (
      <div className="flex min-h-full flex-col">
        <SiteHeader authenticated={loaderData.authenticated} />
        <main className="container-pulse flex-1 py-6 sm:py-10">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            Сравнение товаров
          </h1>
          <div className="card mt-6 p-8 text-center sm:p-12">
            <p aria-hidden="true" className="text-4xl">
              ⚖
            </p>
            <h2 className="mt-4 text-lg font-semibold text-slate-900">
              Выберите минимум два товара одной категории
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">
              Откройте карточку товара и нажмите «Сравнить» — или соберите ссылку вида{" "}
              <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">?ids=uuid,uuid</code>. Сравнить
              можно до {MAX_COMPARE} товаров.
            </p>
            <a
              href="/catalog"
              className="mt-6 inline-block rounded-xl bg-pulse-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-pulse-700"
            >
              Перейти в каталог
            </a>
          </div>
        </main>
        <SiteFooter />
      </div>
    );
  }

  const payload = loaderData.state === "ready" ? loaderData.payload : null;

  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader authenticated={loaderData.authenticated} />

      <main className="container-pulse flex-1 py-6 sm:py-10">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
          Сравнение: {payload ? payload.category.name : "товаров"}
        </h1>

        {payload ? (
          <p className="mt-1.5 text-sm text-slate-600">
            {payload.products.length}{" "}
            {plural(payload.products.length, "товар", "товара", "товаров")} · отличающихся
            характеристик: {payload.different_count}, совпадающих: {payload.identical_count}
          </p>
        ) : null}

        {!loaderData.ok ? (
          <div role="alert" className="card mt-6 border-rose-200 bg-rose-50 p-6 text-center">
            <p className="text-sm font-semibold text-rose-700">
              {loaderData.error.status > 0 ? `Ошибка ${loaderData.error.status}` : "Нет связи с сервером"}
            </p>
            <p className="mt-2 text-sm text-slate-700">{loaderData.error.message}</p>
            {/*
              Две частые ошибки объясняем отдельно: это не сбой, а подсказка
              что делать дальше — сравнить товары одной категории или убрать
              лишние из ссылки.
            */}
            {loaderData.error.code === "mixed_categories" ? (
              <p className="mt-2 text-sm text-slate-700">
                Сравнивать можно только товары одной категории — выберите их в{" "}
                <a href="/catalog" className="font-medium text-pulse-700 hover:text-pulse-800">
                  каталоге
                </a>
                .
              </p>
            ) : null}
            {loaderData.error.code === "too_many_products_to_compare" ? (
              <p className="mt-2 text-sm text-slate-700">
                В ссылке больше {MAX_COMPARE} товаров — оставьте не более {MAX_COMPARE}.
              </p>
            ) : null}
            <a
              href="/catalog"
              className="mt-5 inline-block rounded-xl bg-pulse-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-pulse-700"
            >
              Выбрать товары
            </a>
          </div>
        ) : payload ? (
          <>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <a
                href={hrefWithOnly(loaderData.ids, !loaderData.onlyDifferent)}
                className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
                aria-pressed={loaderData.onlyDifferent}
              >
                {loaderData.onlyDifferent ? "Показать все характеристики" : "Только отличающиеся"}
              </a>
              <span className="text-xs text-slate-500">
                Ссылку с выбранными товарами можно скопировать и отправить.
              </span>
            </div>

            <div className="mt-4">
              <CompareTable payload={payload} onlyDifferent={loaderData.onlyDifferent} />
            </div>

            <section aria-label="Купить сравниваемые товары" className="mt-6">
              <h2 className="text-lg font-semibold text-slate-900">Куда это пригодилось</h2>
              <ul className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {payload.products.map((product) => (
                  <li key={product.id} className="card p-3.5">
                    <AvailabilityBadge
                      availability={product.availability}
                      quantity={product.available_quantity}
                    />
                    <p className="mt-1.5 text-base font-bold text-slate-900">
                      {formatPrice(product.price)}
                    </p>
                    <div className="mt-3 flex gap-1.5">
                      <AddToCartButton
                        productId={product.id}
                        productName={product.name}
                        compact
                        className="min-w-0 flex-1"
                      />
                      <FavoriteButton
                        productId={product.id}
                        productName={product.name}
                        compact
                        className="shrink-0"
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          </>
        ) : null}
      </main>
      <SiteFooter />
    </div>
  );
}