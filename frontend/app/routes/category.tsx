import { useEffect, useState } from "react";
import { useNavigation, useSearchParams } from "react-router";

import type { Route } from "./+types/category";
import { describeApiError } from "~/lib/api-error";
import { ApiError, serverFetch } from "~/lib/api.server";
import type { CategoryResponse, FilterPatch, SortKey, SortOptions } from "~/lib/catalog";
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
import { ChevronRight, Gpu, SlidersHorizontal } from "~/widgets/icons";
import { ProductGrid, ProductGridSkeleton } from "~/widgets/product-card";
import { SiteFooter } from "~/widgets/site-footer";
import { SiteHeader } from "~/widgets/site-header";

export function meta({ data }: Route.MetaArgs): Route.MetaDescriptors {
  const name = data?.ok === true ? data.payload.category.name : "Категория";
  return [
    { title: `${name} — каталог — ПУЛЬС` },
    { name: "description", content: `${name}: цены, характеристики, наличие и фильтры подбора.` },
  ];
}

const PAGE_SIZE = 24;

/**
 * Страница категории `/catalog/:slug`.
 *
 * Отдельный loader вместо переиспользования /catalog: backend отдаёт для
 * категории сразу хлебные крошки, родителя и подкатегории, а список товаров
 * с теми же `facets`. Фильтры и пагинация работают ровно как в общем каталоге —
 * разбор query-строки общий (~/lib/catalog), поэтому расхождений не будет.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const slug = params.slug ?? "";
  // Категория задана маршрутом, а не фильтром: подставляем её в состояние,
  // чтобы форма фильтров и пагинация работали с тем же набором параметров.
  const selection = parseFilters(url.searchParams, { category: slug });
  const authenticated = Boolean(readAccessToken(request));

  const sortOptionsRequest = serverFetch<SortOptions>("/sort-options").catch(
    (): SortOptions => FALLBACK_SORT_OPTIONS,
  );

  try {
    const [payload, sortOptions] = await Promise.all([
      serverFetch<CategoryResponse>(
        `/categories/${encodeURIComponent(slug)}?${buildProductQuery({ ...selection, limit: PAGE_SIZE })}`,
      ),
      sortOptionsRequest,
    ]);
    return { ok: true as const, authenticated, selection, payload, sortOptions, slug };
  } catch (cause) {
    // Несуществующий slug — это честный 404, его обработает ErrorBoundary
    // корневого маршрута («Страница не найдена»). Остальное показываем
    // как состояние ошибки внутри страницы: каталог остаётся доступен.
    if (cause instanceof ApiError && cause.status === 404) {
      throw new Response("Категория не найдена", { status: 404, statusText: "Категория не найдена" });
    }
    return {
      ok: false as const,
      authenticated,
      selection,
      slug,
      error: describeApiError(cause, "Не удалось загрузить категорию"),
    };
  }
}

function Breadcrumbs({
  items,
  current,
}: {
  items: { name: string; slug: string }[];
  current: string;
}) {
  return (
    <nav aria-label="Хлебные крошки">
      <ol className="flex flex-wrap items-center gap-2.5 text-xs text-slate-600">
        <li>
          <a href="/" className="transition-colors hover:text-pulse-600">
            Главная
          </a>
        </li>
        {items.map((item) => (
          <li key={item.slug} className="flex items-center gap-2.5">
            <ChevronRight className="h-3 w-3 shrink-0 text-slate-400" aria-hidden="true" />
            {item.slug === current ? (
              <span aria-current="page" className="text-slate-900">
                {item.name}
              </span>
            ) : (
              <a href={`/catalog/${item.slug}`} className="transition-colors hover:text-pulse-600">
                {item.name}
              </a>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export default function Category({ loaderData }: Route.ComponentProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigation = useNavigation();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const busy = navigation.state !== "idle";
  const { authenticated, selection, slug } = loaderData;

  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  const handlePatch = (patch: FilterPatch): void => {
    setSearchParams(applyPatch(searchParams, patch));
    setDrawerOpen(false);
  };

  /** Категория задаётся маршрутом — её сброс не удаляет, иначе страница сменится. */
  const handleReset = (): void => {
    const next = new URLSearchParams();
    const query = searchParams.get("q");
    if (query) next.set("q", query);
    setSearchParams(next, { preventScrollReset: true });
    setDrawerOpen(false);
  };

  const category = loaderData.ok ? loaderData.payload.category : null;
  const products = loaderData.ok ? loaderData.payload.products : null;
  const total = products ? products.total : 0;
  const activeCount = activeFilterCount(selection);

  const panel = (
    <FilterPanel
      facets={products ? products.facets : EMPTY_FACETS}
      selection={selection}
      onPatch={handlePatch}
      onReset={handleReset}
      idPrefix="category"
      resultCount={total}
    />
  );

  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader authenticated={authenticated} />

      <main className="container-pulse flex-1 pt-7 pb-12">
        {loaderData.ok ? (
          <Breadcrumbs items={loaderData.payload.breadcrumb} current={loaderData.payload.category.slug} />
        ) : (
          <Breadcrumbs items={[]} current={slug} />
        )}

        <header className="mt-6 flex flex-wrap items-baseline gap-4.5">
          <h1 className="text-[2.375rem] leading-tight font-bold text-slate-900">
            {category ? category.name : "Категория"}
          </h1>
          <p className="text-[0.9375rem] text-slate-600" aria-live="polite">
            {loaderData.ok
              ? `${total} ${plural(total, "товар", "товара", "товаров")}`
              : "Список товаров этой категории сейчас недоступен"}
          </p>
        </header>

        {category && category.children.length > 0 ? (
          <nav aria-label="Подкатегории" className="mt-6">
            <ul className="flex flex-wrap gap-2.5">
              <li>
                <a
                  href={`/catalog/${category.slug}`}
                  aria-current="page"
                  className="inline-flex items-center rounded-control border border-ink-900 bg-ink-900 px-4 py-2.5 text-[0.8125rem] font-medium text-white"
                >
                  Все {category.name.toLowerCase()}
                </a>
              </li>
              {category.children.map((child) => (
                <li key={child.id}>
                  <a
                    href={`/catalog/${child.slug}`}
                    className="inline-flex items-center rounded-control border border-slate-200 bg-white px-4 py-2.5 text-[0.8125rem] font-medium text-slate-900 transition-colors hover:border-pulse-400 hover:text-pulse-600"
                  >
                    {child.name}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}

        <div className="mt-6 lg:grid lg:grid-cols-[17rem_minmax(0,1fr)] lg:gap-6">
          <aside className="hidden lg:block">
            <div className="sticky top-44 max-h-[calc(100vh-13rem)] overflow-y-auto pb-2">
              {panel}
            </div>
          </aside>

          <section aria-label="Товары" className="flex flex-col gap-4">
            {/* Совет по выбору — тёмная плашка из макета. */}
            <div className="flex flex-col gap-4 rounded-card bg-ink-900 p-5 sm:flex-row sm:items-center">
              <Gpu className="h-8 w-8 shrink-0 text-accent-500" aria-hidden="true" />
              <div className="flex flex-1 flex-col gap-1">
                <p className="text-[1.0625rem] font-semibold text-white">
                  Подберите видеокарту под свой монитор
                </p>
                <p className="text-xs text-ink-muted">
                  1080p, 1440p или 4K — поможем найти баланс мощности и цены.
                </p>
              </div>
              <a
                href="/catalog"
                className="inline-flex h-11 shrink-0 items-center rounded-control border border-slate-200 bg-white px-[1.125rem] text-[0.9375rem] font-semibold text-slate-900 transition-colors hover:bg-slate-50"
              >
                Гид по выбору
              </a>
            </div>

            <CatalogToolbar
              sort={selection.sort}
              sortOptions={loaderData.ok ? loaderData.sortOptions : FALLBACK_SORT_OPTIONS}
              activeCount={activeCount}
              total={total}
              onSortChange={(sort: SortKey) => handlePatch({ kind: "sort", value: sort })}
              onOpenFilters={() => setDrawerOpen(true)}
            />

            {activeCount > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                <SlidersHorizontal className="h-4 w-4 text-slate-400" aria-hidden="true" />
                <button
                  type="button"
                  onClick={handleReset}
                  className="text-xs font-medium text-pulse-600 transition-colors hover:text-pulse-700"
                >
                  Сбросить все
                </button>
              </div>
            ) : null}

            {busy ? (
              <ProductGridSkeleton count={6} />
            ) : !loaderData.ok ? (
              <CatalogError message={loaderData.error.message} status={loaderData.error.status} />
            ) : !products || products.items.length === 0 ? (
              <CatalogEmpty />
            ) : (
              <>
                <ProductGrid products={products.items} />

                {products.pages > products.page ? (
                  <a
                    href={pageHref(`/catalog/${slug}`, searchParams, products.page + 1)}
                    className="mt-2 inline-flex h-11 items-center justify-center gap-2 rounded-control border border-slate-200 bg-white px-5 text-[0.9375rem] font-semibold text-slate-900 transition-colors hover:border-pulse-400 hover:text-pulse-600"
                  >
                    Показать ещё {products.limit} товаров
                  </a>
                ) : null}

                <CatalogPagination
                  page={products.page}
                  pages={products.pages}
                  makeHref={(page) => pageHref(`/catalog/${slug}`, searchParams, page)}
                />
              </>
            )}
          </section>
        </div>
      </main>

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
            aria-label="Фильтры категории"
            className="absolute inset-y-0 left-0 flex w-[min(20rem,88vw)] flex-col bg-white shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h2 className="text-base font-semibold text-slate-900">Фильтры</h2>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="rounded-control px-2.5 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50"
              >
                Закрыть
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-4">{panel}</div>
          </div>
        </div>
      ) : null}

      <SiteFooter />
    </div>
  );
}