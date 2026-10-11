import { useEffect, useState } from "react";
import { useNavigation, useSearchParams } from "react-router";

import type { Route } from "./+types/catalog";
import { describeApiError } from "~/lib/api-error";
import { serverFetch } from "~/lib/api.server";
import type { FilterPatch, ProductList, SortOptions } from "~/lib/catalog";
import {
  activeFilterCount,
  applyPatch,
  buildProductQuery,
  FALLBACK_SORT_OPTIONS,
  pageHref,
  parseFilters,
} from "~/lib/catalog";
import { readAccessToken } from "~/lib/auth-token";
import { plural } from "~/lib/format";
import { CatalogPagination } from "~/widgets/catalog-pagination";
import { CatalogEmpty, CatalogError, CatalogToolbar, EMPTY_FACETS } from "~/widgets/catalog-ui";
import { FilterPanel } from "~/widgets/filter-panel";
import { ProductGrid, ProductGridSkeleton } from "~/widgets/product-card";
import { SiteHeader } from "~/widgets/site-header";
import { SiteFooter } from "~/widgets/site-footer";

export function meta({ data }: Route.MetaArgs): Route.MetaDescriptors {
  const query = data?.ok === true ? data.selection.q : "";
  const title = query ? `${query} — поиск по каталогу` : "Каталог комплектующих";
  return [
    { title: `${title} — ПУЛЬС` },
    {
      name: "description",
      content: "Каталог компьютерных комплектующих: фильтры по бренду, цене, характеристикам и наличию.",
    },
  ];
}

const PAGE_SIZE = 24;

/**
 * Каталог `/catalog`.
 *
 * Единственный источник состояния — query-строка: loader читает её из
 * `request.url`, компонент меняет её через `useSearchParams`. Поэтому смена
 * фильтра — обычный переход с новым набором товаров, а кнопка «Назад»
 * возвращает предыдущий набор. Данные приходят только через `serverFetch`
 * в loader: клиентский fetch во время SSR не выполняется.
 *
 * Ошибка backend-а не бросается наружу, а возвращается в данных: страница
 * показывает понятный текст и остаётся с шапкой и фильтрами, а не
 * превращается в белый экран.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const selection = parseFilters(url.searchParams);
  const authenticated = Boolean(readAccessToken(request));

  // Подписи сортировки не критичны для выдачи: если эндпоинт недоступен,
  // показываем встроенные — форма работает, перевод не блокирует каталог.
  const sortOptionsRequest = serverFetch<SortOptions>("/sort-options").catch(
    (): SortOptions => FALLBACK_SORT_OPTIONS,
  );

  try {
    const [list, sortOptions] = await Promise.all([
      serverFetch<ProductList>(`/products?${buildProductQuery({ ...selection, limit: PAGE_SIZE })}`),
      sortOptionsRequest,
    ]);
    return { ok: true as const, authenticated, selection, list, sortOptions };
  } catch (cause) {
    return {
      ok: false as const,
      authenticated,
      selection,
      error: describeApiError(cause, "Не удалось загрузить каталог"),
    };
  }
}

export default function Catalog({ loaderData }: Route.ComponentProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigation = useNavigation();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Клиентский переход по фильтру идёт через loader, поэтому пока он не
  // завершён, показываем скелетоны на месте прежней сетки: список не дёргается.
  const busy = navigation.state !== "idle";

  // Escape закрывает мобильную панель — обычное ожидание от шторки.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  const { authenticated, selection } = loaderData;

  const handlePatch = (patch: FilterPatch): void => {
    setSearchParams(applyPatch(searchParams, patch));
    setDrawerOpen(false);
  };

  /** Сброс фильтров сохраняет поисковый запрос: он задаёт сам каталог, а не отбор. */
  const handleReset = (): void => {
    const next = new URLSearchParams();
    const query = searchParams.get("q");
    if (query) next.set("q", query);
    setSearchParams(next, { preventScrollReset: true });
    setDrawerOpen(false);
  };

  const panel = (
    <FilterPanel
      facets={loaderData.ok ? loaderData.list.facets : EMPTY_FACETS}
      selection={selection}
      onPatch={handlePatch}
      onReset={handleReset}
      idPrefix="catalog"
    />
  );

  const activeCount = activeFilterCount(selection);

  const total = loaderData.ok ? loaderData.list.total : 0;

  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader authenticated={authenticated} />

      <main className="container-pulse flex-1 py-6 sm:py-10">
        <header className="mb-5">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">Каталог</h1>
          <p className="mt-1.5 text-sm text-slate-600" aria-live="polite">
            {loaderData.ok ? (
              <>
                Найдено {total} {plural(total, "товар", "товара", "товаров")}
                {selection.q ? ` по запросу «${selection.q}»` : ""}
              </>
            ) : (
              "Список товаров сейчас недоступен"
            )}
          </p>
        </header>

        <div className="lg:grid lg:grid-cols-[17rem_minmax(0,1fr)] lg:gap-8">
          <aside className="hidden lg:block">
            <div className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto pr-2 pb-4">
              {panel}
            </div>
          </aside>

          <section aria-label="Товары">
            <CatalogToolbar
              sort={selection.sort}
              sortOptions={loaderData.ok ? loaderData.sortOptions : FALLBACK_SORT_OPTIONS}
              activeCount={activeCount}
              total={total}
              onSortChange={(sort) => handlePatch({ kind: "sort", value: sort })}
              onOpenFilters={() => setDrawerOpen(true)}
            />

            {busy ? (
              <ProductGridSkeleton count={PAGE_SIZE > 8 ? 8 : PAGE_SIZE} />
            ) : !loaderData.ok ? (
              <CatalogError message={loaderData.error.message} status={loaderData.error.status} />
            ) : loaderData.list.items.length === 0 ? (
              <CatalogEmpty />
            ) : (
              <>
                <ProductGrid products={loaderData.list.items} />
                <CatalogPagination
                  page={loaderData.list.page}
                  pages={loaderData.list.pages}
                  makeHref={(page) => pageHref("/catalog", searchParams, page)}
                />
              </>
            )}
          </section>
        </div>
      </main>
      <SiteFooter />

      {drawerOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Закрыть фильтры"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-slate-900/40"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Фильтры каталога"
            className="absolute inset-y-0 left-0 flex w-[min(20rem,88vw)] flex-col bg-white shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h2 className="text-base font-semibold text-slate-900">Фильтры</h2>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="rounded-lg px-2.5 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100"
              >
                Закрыть
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-4">{panel}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
