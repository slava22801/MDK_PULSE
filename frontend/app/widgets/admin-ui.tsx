import type { ReactNode } from "react";
import { Form, Link } from "react-router";

import type { ApiErrorInfo } from "~/lib/api-error";
import { adminPageHref, formatDateTime } from "~/lib/admin";
import { formatPrice } from "~/lib/format";

/**
 * Мелкие блоки админ-панели: заголовок раздела, уведомление, пагинация,
 * таблица и состояние «пусто».
 *
 * Держим их в отдельном виджете, а не продублированно в девяти разделах:
 * оформление пустого состояния или ошибки должно быть одинаковым везде —
 * раздел 9 ТЗ требует единых состояний, а не «как успел автор».
 *
 * Модуль изоморфный: `Link`/`Form` работают и на сервере, и в браузере.
 */

/** Заголовок страницы раздела с пояснением и местом под кнопки. */
export function AdminPageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
        {description ? <p className="mt-1 text-sm text-slate-600">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * Уведомление об ошибке или успехе.
 *
 * `role="alert"` и `role="status"` — не украшение: без них скринридер не
 * объявит результат действия, а пользователь решит, что кнопка не сработала.
 */
export function AdminNotice({
  ok,
  error,
  errorCode,
  children,
}: {
  ok?: string | undefined;
  error?: string | undefined;
  errorCode?: string | undefined;
  children?: ReactNode;
}) {
  if (error) {
    return (
      <div
        role="alert"
        className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
      >
        <p className="font-medium">{error}</p>
        {errorCode ? <p className="mt-1 text-xs text-rose-600">Код ошибки: {errorCode}</p> : null}
        {children}
      </div>
    );
  }
  if (ok) {
    return (
      <p
        role="status"
        className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800"
      >
        {ok}
      </p>
    );
  }
  return null;
}

/** Единое пустое состояние: раздел работает, данных просто нет. */
export function EmptyState({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {hint ? <p className="mt-1 text-sm text-slate-500">{hint}</p> : null}
    </div>
  );
}

/**
 * Плашка «раздел недоступен».
 *
 * Отдельное состояние от пустого: 403 — это «прав нет», и подменять его
 * надписью «ничего не найдено» нельзя, сотрудник решит, что база пуста.
 */
export function ForbiddenState({ message }: { message?: string }) {
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-4 text-sm text-amber-900">
      <p className="font-medium">Раздел недоступен вашей роли</p>
      <p className="mt-1">
        {message ?? "Обратитесь к администратору, если нужно расширить права."}
      </p>
    </div>
  );
}

/**
 * Постраничная навигация.
 *
 * Ссылки обычные `<Link>`: в отличие от загрузок через `serverFetch`, навигация
 * по query работает на клиенте — данные страницы всё равно перечитает loader
 * после перехода, поэтому полная перезагрузка здесь не нужна.
 *
 * Всегда показываем соседей текущей страницы: при 20 страницах список «1 … 20»
 * бесполезен, а две кнопки «назад/вперёд» заставляют считать страницы вручную.
 */
export function AdminPagination({
  pathname,
  search,
  page,
  pages,
  total,
}: {
  pathname: string;
  search: URLSearchParams;
  page: number;
  pages: number;
  total: number;
}) {
  if (pages <= 1) {
    return (
      <p className="mt-4 text-sm text-slate-600">
        {total} {total === 1 ? "запись" : "записей"}
      </p>
    );
  }

  return (
    <nav
      aria-label="Постраничная навигация"
      className="mt-5 flex flex-wrap items-center gap-2 text-sm"
    >
      {page > 1 ? (
        <Link
          to={adminPageHref(pathname, search, page - 1)}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
        >
          Назад
        </Link>
      ) : null}

      {pageWindow(page, pages).map((entry, index) =>
        entry === null ? (
          <span key={`gap-${index}`} aria-hidden="true" className="px-1 text-slate-400">
            …
          </span>
        ) : (
          <Link
            key={entry}
            to={adminPageHref(pathname, search, entry)}
            aria-current={entry === page ? "page" : undefined}
            className={[
              "rounded-lg px-3 py-1.5 font-medium",
              entry === page
                ? "bg-pulse-600 text-white"
                : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
            ].join(" ")}
          >
            {entry}
          </Link>
        ),
      )}

      {page < pages ? (
        <Link
          to={adminPageHref(pathname, search, page + 1)}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
        >
          Вперёд
        </Link>
      ) : null}

      <span className="ms-auto text-slate-600">
        Страница {page} из {pages} · всего {total}
      </span>
    </nav>
  );
}

/**
 * Окно страниц вокруг текущей: первая, последняя и ±2 от текущей.
 *
 * Держим список коротким сознательно: пятьдесят ссылок подряд читаются хуже,
 * чем четыре стрелки с числом страницы.
 */
function pageWindow(page: number, pages: number): (number | null)[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);

  const result: (number | null)[] = [1];
  const from = Math.max(2, page - 2);
  const to = Math.min(pages - 1, page + 2);

  if (from > 2) result.push(null);
  for (let i = from; i <= to; i += 1) result.push(i);
  if (to < pages - 1) result.push(null);
  result.push(pages);

  return result;
}

/**
 * Обёртка таблицы.
 *
 * Горизонтальная прокрутка обязательна: на 320px таблица из семи колонок
 * иначе вылезет за экран и сделает всю страницу нечитаемой по горизонтали.
 */
export function AdminTable({
  caption,
  headers,
  children,
}: {
  caption: string;
  headers: readonly string[];
  children: ReactNode;
}) {
  return (
    <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="w-full min-w-[46rem] border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-slate-50 text-xs tracking-wide text-slate-500 uppercase">
          <tr>
            {headers.map((header) => (
              <th key={header} scope="col" className="px-3 py-2.5 font-semibold whitespace-nowrap">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </div>
  );
}

/** Ячейка таблицы: `nowrap` у monetary-колонок задаётся на уровне ячейки. */
export function AdminCell({
  children,
  nowrap,
}: {
  children: ReactNode;
  nowrap?: boolean;
}) {
  return <td className={nowrap ? "px-3 py-2.5 whitespace-nowrap" : "px-3 py-2.5 align-top"}>{children}</td>;
}

/** Цветной статус: тот же словарь, что и на витрине, чтобы слова совпадали. */
export function StatusBadge({ label, tone }: { label: string; tone: string }) {
  return (
    <span className={`inline-block rounded-lg px-2 py-0.5 text-xs font-semibold ${tone}`}>
      {label}
    </span>
  );
}

/** Цвет тона статуса заказа/товара по значению. */
export function statusTone(status: string): string {
  switch (status) {
    case "completed":
    case "published":
    case "in_stock":
      return "bg-emerald-100 text-emerald-800";
    case "cancelled":
    case "rejected":
    case "discontinued":
      return "bg-rose-100 text-rose-700";
    case "new":
    case "pending":
    case "awaiting_payment":
    case "low_stock":
      return "bg-amber-100 text-amber-800";
    case "shipped":
    case "assembling":
    case "on_order":
    case "expected":
      return "bg-violet-100 text-violet-800";
    case "return_requested":
      return "bg-amber-100 text-amber-800";
    case "hidden":
    case "out_of_stock":
      return "bg-slate-200 text-slate-700";
    default:
      return "bg-slate-100 text-slate-700";
  }
}

/** Кнопка в форме отправки; `intent` обязателен — action'ы различаются по нему. */
export function ActionButton({
  intent,
  children,
  tone = "default",
  busy = false,
  busyLabel = "Сохраняем…",
  disabled = false,
  form = undefined,
}: {
  intent: string;
  children: ReactNode;
  tone?: "default" | "primary" | "danger" | "ghost";
  busy?: boolean;
  busyLabel?: string;
  disabled?: boolean;
  form?: string;
}) {
  const tones: Record<string, string> = {
    default: "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
    primary: "bg-pulse-600 text-white hover:bg-pulse-700",
    danger: "border border-slate-300 bg-white text-rose-600 hover:border-rose-300",
    ghost: "px-2 py-1 text-slate-600 hover:bg-slate-100",
  };

  return (
    <button
      type="submit"
      name="intent"
      value={intent}
      form={form}
      disabled={busy || disabled}
      className={`rounded-xl px-3.5 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${tones[tone] ?? tones.default}`}
    >
      {busy ? busyLabel : children}
    </button>
  );
}

/**
 * Форма-фильтр: обычная GET-форма.
 *
 * Работает без JavaScript — фильтр меняет query, loader перечитывает данные.
 * Кнопка «Применить» нужна именно поэтому: без неё фильтры применились бы
 * только по Enter, а на телефоне кнопки Enter нет.
 */
export function FilterBar({ action, children }: { action: string; children: ReactNode }) {
  return (
    <Form
      method="get"
      action={action}
      className="mt-5 flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3"
    >
      {children}
    </Form>
  );
}

/** Поле фильтра: label + control, связанные через htmlFor + id. */
export function FilterField({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 flex-1 basis-40">
      <label htmlFor={id} className="block text-xs font-medium text-slate-600">
        {label}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

/** Общий класс полей админки — совпадает по виду с витриной. */
export const ADMIN_INPUT =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-pulse-500";

/** Текстовое поле формы: подпись, ошибка сервера и подсказка. */
export function AdminField({
  id,
  label,
  error,
  hint,
  children,
  required = false,
}: {
  id: string;
  label: string;
  error?: string | undefined;
  hint?: ReactNode;
  children: ReactNode;
  required?: boolean;
}) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
        {required ? (
          <span aria-hidden="true" className="ms-1 text-rose-600">
            *
          </span>
        ) : null}
      </label>
      {children}
      {hint ? (
        <p id={hintId} className="text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-sm font-medium text-rose-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Текстовая область с подписью (textarea не покрывается ADMIN_INPUT на <input>). */
export function AdminTextarea({
  id,
  name,
  defaultValue,
  rows = 3,
  error,
  placeholder,
  maxLength,
}: {
  id: string;
  name: string;
  defaultValue?: string;
  rows?: number;
  error?: string | undefined;
  placeholder?: string;
  maxLength?: number;
}) {
  return (
    <textarea
      id={id}
      name={name}
      rows={rows}
      maxLength={maxLength}
      defaultValue={defaultValue}
      placeholder={placeholder}
      aria-invalid={error ? true : undefined}
      className={`${ADMIN_INPUT} ${error ? "border-rose-400" : ""}`}
    />
  );
}

/** Денежная ячейка: суммы — строки, их форматирует `formatPrice`. */
export function MoneyCell({ value }: { value: string | null }) {
  return <span className="whitespace-nowrap">{formatPrice(value)}</span>;
}

/** Дата в таблице: узкая колонка, поэтому фиксированный формат. */
export function DateCell({ value }: { value: string | null }) {
  return <span className="whitespace-nowrap text-slate-600">{formatDateTime(value)}</span>;
}

/** Текст ошибки раздела: 403 и отсутствие сети читаются по-разному. */
export function LoadError({ error }: { error: ApiErrorInfo }) {
  if (error.status === 403) {
    return <ForbiddenState message={error.message} />;
  }
  return (
    <div
      role="alert"
      className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
    >
      <p className="font-medium">Не удалось загрузить раздел</p>
      <p className="mt-1">{error.message}</p>
    </div>
  );
}