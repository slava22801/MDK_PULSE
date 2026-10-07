import type { Facets, SortKey, SortOptions } from "~/lib/catalog";
import { FALLBACK_SORT_OPTIONS, SORT_KEYS } from "~/lib/catalog";

/**
 * Общие элементы списка товаров: панель управления выдачей и состояния,
 * в которые список попадать может — их переиспользует и /catalog,
 * и /catalog/:slug, чтобы страницы не расходились оформлением.
 */

export type CatalogToolbarProps = {
  sort: SortKey;
  sortOptions: SortOptions;
  activeCount: number;
  onSortChange: (sort: SortKey) => void;
  onOpenFilters: () => void;
};

/**
 * Панель над сеткой: кнопка фильтров (только на мобильных) и сортировка.
 *
 * Метки сортировки приходят с backend-а, поэтому язык магазина меняется там.
 */
export function CatalogToolbar({
  sort,
  sortOptions,
  activeCount,
  onSortChange,
  onOpenFilters,
}: CatalogToolbarProps) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <button
        type="button"
        onClick={onOpenFilters}
        className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 lg:hidden"
      >
        Фильтры
        {activeCount > 0 ? (
          <span className="rounded-full bg-pulse-600 px-2 py-0.5 text-xs font-bold text-white">
            {activeCount}
          </span>
        ) : null}
      </button>

      <div className="ms-auto flex items-center gap-2">
        <label htmlFor="catalog-sort" className="shrink-0 text-sm text-slate-600">
          Сортировка
        </label>
        <select
          id="catalog-sort"
          value={sort}
          onChange={(event) => onSortChange(event.target.value as SortKey)}
          className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900"
        >
          {SORT_KEYS.map((option) => (
            <option key={option} value={option}>
              {sortOptions[option] ?? FALLBACK_SORT_OPTIONS[option]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/** Пустая выдача: не ошибка, а отсутствие совпадений — предлагаем снять фильтры. */
export function CatalogEmpty() {
  return (
    <div className="card p-8 text-center sm:p-12">
      <p aria-hidden="true" className="text-4xl">
        🔍
      </p>
      <h2 className="mt-4 text-lg font-semibold text-slate-900">По вашему запросу ничего не найдено</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">
        Попробуйте убрать часть фильтров, изменить диапазон цен или поисковый запрос — возможно,
        товаров по этому набору просто нет.
      </p>
      <a
        href="/catalog"
        className="mt-6 inline-block rounded-xl bg-pulse-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-pulse-700"
      >
        Сбросить фильтры
      </a>
    </div>
  );
}

/** Ошибка сервера каталога: текст остаётся в магазине, ссылка предлагает повтор. */
export function CatalogError({ message, status }: { message: string; status: number }) {
  return (
    <div role="alert" className="card border-rose-200 bg-rose-50 p-6 text-center sm:p-10">
      <p className="text-sm font-semibold text-rose-700">
        {status > 0 ? `Ошибка ${status}` : "Нет связи с сервером"}
      </p>
      <h2 className="mt-2 text-lg font-semibold text-slate-900">Каталог не загрузился</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-slate-700">{message}</p>
      <a
        href=""
        className="mt-6 inline-block rounded-xl bg-pulse-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-pulse-700"
      >
        Попробовать снова
      </a>
    </div>
  );
}

/** Пустой набор фасетов — чтобы форма фильтров рендерилась и при ошибке загрузки. */
export const EMPTY_FACETS: Facets = {
  brands: [],
  price: { min: null, max: null },
  availability: [],
  attributes: [],
};
