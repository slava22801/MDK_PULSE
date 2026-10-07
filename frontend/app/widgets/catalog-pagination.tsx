/**
 * Постраничная навигация каталога.
 *
 * Ссылки — обычные `<a>`, поэтому пагинация работает без JavaScript и
 * сохраняет в адресе все фильтры: список строится из текущей query-строки,
 * меняется только `page`. Клиентский переход здесь не нужен — он бы всё
 * равно потребовал ответа сервера, а полная перезагрузка заодно обновляет
 * мета-теги и историю так, как ожидает поисковик.
 */

export type CatalogPaginationProps = {
  page: number;
  pages: number;
  /** Ссылка на страницу: собирается на стороне маршрута из текущих фильтров. */
  makeHref: (page: number) => string;
};

type PageItem = number | "gap";

/**
 * Компактный список страниц: первая, последняя, соседи текущей и «разрывы»
 * вместо длинного ряда из сотни ссылок на 320px.
 */
function pageItems(page: number, pages: number): PageItem[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, index) => index + 1);

  const items: PageItem[] = [1];
  const from = Math.max(2, page - 1);
  const to = Math.min(pages - 1, page + 1);

  if (from > 2) items.push("gap");
  for (let current = from; current <= to; current += 1) items.push(current);
  if (to < pages - 1) items.push("gap");
  items.push(pages);

  return items;
}

const LINK_CLASS =
  "inline-flex min-w-9 items-center justify-center rounded-lg border px-3 py-2 text-sm font-medium transition-colors";

export function CatalogPagination({ page, pages, makeHref }: CatalogPaginationProps) {
  if (pages <= 1) return null;

  const items = pageItems(page, pages);
  const previous = page > 1;
  const next = page < pages;

  return (
    <nav aria-label="Постраничная навигация" className="mt-8">
      <ul className="flex flex-wrap items-center justify-center gap-1.5">
        <li>
          {previous ? (
            <a href={makeHref(page - 1)} className={`${LINK_CLASS} border-slate-300 bg-white text-slate-700 hover:bg-slate-50`} rel="prev">
              Назад
            </a>
          ) : (
            <span aria-disabled="true" className={`${LINK_CLASS} border-slate-200 bg-slate-50 text-slate-400`}>
              Назад
            </span>
          )}
        </li>

        {items.map((item, index) =>
          item === "gap" ? (
            <li key={`gap-${index}`} aria-hidden="true" className="px-1 text-slate-400">
              …
            </li>
          ) : (
            <li key={item}>
              {item === page ? (
                <span aria-current="page" className={`${LINK_CLASS} border-pulse-600 bg-pulse-600 text-white`}>
                  {item}
                </span>
              ) : (
                <a
                  href={makeHref(item)}
                  className={`${LINK_CLASS} border-slate-300 bg-white text-slate-700 hover:bg-slate-50`}
                >
                  {item}
                </a>
              )}
            </li>
          ),
        )}

        <li>
          {next ? (
            <a href={makeHref(page + 1)} className={`${LINK_CLASS} border-slate-300 bg-white text-slate-700 hover:bg-slate-50`} rel="next">
              Вперёд
            </a>
          ) : (
            <span aria-disabled="true" className={`${LINK_CLASS} border-slate-200 bg-slate-50 text-slate-400`}>
              Вперёд
            </span>
          )}
        </li>
      </ul>
    </nav>
  );
}
