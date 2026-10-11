import type { Facets, SortKey, SortOptions } from "~/lib/catalog";
import { FALLBACK_SORT_OPTIONS, SORT_KEYS } from "~/lib/catalog";
import { plural } from "~/lib/format";

/**
 * Общие элементы списка товаров: панель управления выдачей и состояния,
 * в которые список попадать может — их переиспользует и /catalog,
 * и /catalog/:slug, чтобы страницы не расходились оформлением.
 */

export type CatalogToolbarProps = {
  sort: SortKey;
  sortOptions: SortOptions;
  activeCount: number;
  /** Число товаров в выдаче — выводится справа от панели. */
  total?: number;
  onSortChange: (sort: SortKey) => void;
  onOpenFilters: () => void;
};

const SELECT_CLASS =
  "h-9 rounded-pill border border-slate-200 bg-white px-3 text-[0.8125rem] font-medium text-slate-900 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pulse-600";

/**
 * Панель над сеткой: кнопка фильтров (только на мобильных), сортировка
 * и число найденного — как в макете страницы категории.
 *
 * Метки сортировки приходят с backend-а, поэтому язык магазина меняется там.
 */
export function CatalogToolbar({
  sort,
  sortOptions,
  activeCount,
  total,
  onSortChange,
  onOpenFilters,
}: CatalogToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-control border border-slate-200 bg-white p-3">
      <button
        type="button"
        onClick={onOpenFilters}
        className="inline-flex h-9 items-center gap-2 rounded-control bg-pulse-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-pulse-700 lg:hidden"
      >
        Фильтры
        {activeCount > 0 ? (
          <span className="rounded-pill bg-white/25 px-1.5 py-0.5 text-xs font-bold">
            {activeCount}
          </span>
        ) : null}
      </button>

      <label htmlFor="catalog-sort" className="sr-only">
        Сортировка
      </label>
      <select
        id="catalog-sort"
        value={sort}
        onChange={(event) => onSortChange(event.target.value as SortKey)}
        className={`${SELECT_CLASS} w-full sm:w-[17.375rem]`}
      >
        {SORT_KEYS.map((option) => (
          <option key={option} value={option}>
            {sortOptions[option] ?? FALLBACK_SORT_OPTIONS[option]}
          </option>
        ))}
      </select>

      <span className="ml-auto text-xs text-slate-600" aria-live="polite">
        {total !== undefined
          ? `Найдено ${total} ${plural(total, "товар", "товара", "товаров")}`
          : null}
      </span>
    </div>
  );
}

/** Пустая выдача: не ошибка, а отсутствие совпадений — предлагаем снять фильтры. */
export function CatalogEmpty() {
  return (
    <div className="rounded-card border border-slate-200 bg-white p-8 text-center sm:p-12">
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
        className="mt-6 inline-flex h-11 items-center rounded-control bg-pulse-600 px-5 text-[0.9375rem] font-semibold text-white transition-colors hover:bg-pulse-700"
      >
        Сбросить фильтры
      </a>
    </div>
  );
}

/** Ошибка сервера каталога: текст остаётся в магазине, ссылка предлагает повтор. */
export function CatalogError({ message, status }: { message: string; status: number }) {
  return (
    <div
      role="alert"
      className="rounded-card border border-rose-200 bg-rose-50 p-6 text-center sm:p-10"
    >
      <p className="text-sm font-semibold text-rose-700">
        {status > 0 ? `Ошибка ${status}` : "Нет связи с сервером"}
      </p>
      <h2 className="mt-2 text-lg font-semibold text-slate-900">Каталог не загрузился</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-slate-700">{message}</p>
      <a
        href=""
        className="mt-6 inline-flex h-11 items-center rounded-control bg-pulse-600 px-5 text-[0.9375rem] font-semibold text-white transition-colors hover:bg-pulse-700"
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