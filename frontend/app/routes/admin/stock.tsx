import { data, Form, useActionData, useNavigation, useSearchParams } from "react-router";

import type { Route } from "./+types/stock";

import type { AdminCategoryRef, AdminPage, AdminStockItem } from "~/lib/admin";
import type { ApiErrorInfo } from "~/lib/api-error";
import { describeApiError } from "~/lib/api-error";
import { serverFetch } from "~/lib/api.server";
import { queryString, requireAdminSession } from "~/lib/admin.server";
import {
  PRODUCT_STATUS_LABEL,
  parseBoolParam,
  parseLimit,
  parsePage,
} from "~/lib/admin";
import {
  ADMIN_INPUT,
  ActionButton,
  AdminCell,
  AdminNotice,
  AdminPageHeader,
  AdminPagination,
  AdminTable,
  EmptyState,
  FilterBar,
  FilterField,
  LoadError,
  StatusBadge,
  statusTone,
} from "~/widgets/admin-ui";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Остатки — Админ-панель — ПУЛЬС" }];
}

/**
 * Остатки товаров: сколько единиц можно продать прямо сейчас.
 *
 * Раздел открыт менеджеру — пересчёт остатков это его ежедневная работа.
 * Каталог с ценами и закупочными ценами при этом остаётся администраторским.
 *
 * Три числа в строке не путаются между собой:
 *   «на складе» — всё, что физически есть;
 *   «в резерве» — ушло в корзины и неоплаченные заказы;
 *   «осталось» — сколько можно продать; именно его и правит сотрудник.
 *
 * Форма работает без JavaScript: обычный POST, который перезагружает страницу
 * с обновлёнными числами.
 */

type StockFilters = {
  search: string;
  categoryId: string;
  onlyLow: boolean;
  page: number;
  limit: number;
};

function readFilters(url: URL): StockFilters {
  return {
    search: (url.searchParams.get("search") ?? "").trim(),
    categoryId: (url.searchParams.get("category_id") ?? "").trim(),
    onlyLow: parseBoolParam(url.searchParams.get("only_low")) === true,
    page: parsePage(url.searchParams.get("page")),
    limit: parseLimit(url.searchParams.get("limit")),
  };
}

type StockActionResult = {
  ok?: string;
  error?: string;
  errorCode?: string;
  /** Товар, для которого не удалось сохранить: строка подсвечивается ошибкой. */
  productId?: string;
};

export async function loader({ request }: Route.LoaderArgs) {
  const session = await requireAdminSession(request, { section: "stock" });
  const url = new URL(request.url);
  const filters = readFilters(url);

  const [list, categories] = await Promise.all([
    serverFetch<AdminPage<AdminStockItem>>(
      `/admin/stock${queryString({
        page: filters.page,
        limit: filters.limit,
        search: filters.search,
        category_id: filters.categoryId,
        only_low: filters.onlyLow ? "true" : null,
      })}`,
      { headers: session.headers },
    ).catch((cause: unknown) => cause as ApiErrorInfo),

    // Справочник категорий не критичен для списка: без него фильтр по
    // категории не отрисуется, но остатки покажутся. Поэтому ошибку не поднимаем.
    serverFetch<{ items: AdminCategoryRef[] }>("/admin/categories", { headers: session.headers }).catch(
      () => ({ items: [] }),
    ),
  ]);

  const listError = list instanceof Error ? describeApiError(list, "Не удалось загрузить остатки") : null;

  return {
    filters,
    stock: listError ? null : (list as AdminPage<AdminStockItem>),
    listError,
    categories: categories.items,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const session = await requireAdminSession(request, { section: "stock" });

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const productId = String(form.get("product_id") ?? "").trim();

  if (intent !== "set") {
    return data<StockActionResult>(
      { error: "Неизвестное действие", errorCode: "unknown_intent" },
      { status: 400 },
    );
  }

  if (!productId) {
    return data<StockActionResult>({ error: "Не указан товар" }, { status: 400 });
  }

  // Количество приходит из поля формы строкой: пустое значение — не «ноль»,
  // а ошибка ввода, и backend должен сказать об этом сам.
  const raw = String(form.get("available_quantity") ?? "").trim();
  const available = Number.parseInt(raw, 10);
  if (!raw || !Number.isFinite(available) || available < 0) {
    return data<StockActionResult>(
      { error: "Укажите количество: целое число не меньше нуля", errorCode: "invalid_quantity", productId },
      { status: 400 },
    );
  }

  try {
    await serverFetch<AdminStockItem>(`/admin/stock/${encodeURIComponent(productId)}`, {
      method: "PATCH",
      headers: session.jsonHeaders,
      body: JSON.stringify({
        available_quantity: available,
        reason: String(form.get("reason") ?? "").trim() || null,
      }),
    });

    return data<StockActionResult>(
      { ok: `Остаток сохранён: осталось ${available} шт`, productId },
      { status: 200 },
    );
  } catch (cause) {
    const info = describeApiError(cause, "Не удалось сохранить остаток");
    return data<StockActionResult>(
      { error: stockErrorMessage(info), errorCode: info.code, productId },
      { status: info.status >= 400 && info.status < 500 ? info.status : 400 },
    );
  }
}

/**
 * Тексты ошибок остатков.
 *
 * Для кодов, где backend уже сказал всё нужное дословно, показываем его
 * сообщение: своя формулировка отстала бы от текста на бэкенде.
 */
function stockErrorMessage(info: ApiErrorInfo): string {
  switch (info.code) {
    case "product_not_found":
    case "not_found":
      return "Товар не найден. Возможно, он удалён — обновите страницу.";
    case "insufficient_role":
      return "Менять остатки может сотрудник магазина.";
    case "validation_error":
      return info.fields._root ?? info.message;
    case "network_error":
      return "Сервер недоступен. Проверьте соединение и повторите действие.";
    default:
      return info.status >= 500
        ? "Сервер временно недоступен, остаток не изменён. Повторите через минуту."
        : info.message;
  }
}

/** Подсветка количества: заканчивается ли товар. */
function availableTone(item: AdminStockItem): string {
  if (item.available_quantity <= 0) return "text-rose-700";
  if (item.min_stock > 0 && item.available_quantity <= item.min_stock) return "text-amber-700";
  return "text-slate-900";
}

export default function AdminStock({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const { filters, categories } = loaderData;
  const stock = loaderData.stock;
  const busy = navigation.state !== "idle";

  const items = stock?.items ?? [];

  return (
    <section>
      <AdminPageHeader
        title="Остатки"
        description="Сколько товара осталось продать. Правьте «Осталось» — товар сразу перестаёт или снова начинает продаваться."
      />
      <AdminNotice
        ok={actionData?.ok}
        error={actionData?.error}
        errorCode={actionData?.errorCode}
      />

      <FilterBar action="/admin/stock">
        <FilterField id="stock-search" label="Поиск">
          <input
            id="stock-search"
            type="search"
            name="search"
            defaultValue={filters.search}
            placeholder="Название или артикул"
            className={ADMIN_INPUT}
          />
        </FilterField>

        <FilterField id="stock-category" label="Категория">
          <select
            id="stock-category"
            name="category_id"
            defaultValue={filters.categoryId}
            className={ADMIN_INPUT}
          >
            <option value="">Все</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </FilterField>

        <div className="min-w-0 flex-1 basis-40">
          <label
            htmlFor="stock-only-low"
            className="flex items-center gap-2 text-xs font-medium text-slate-600"
          >
            <input
              id="stock-only-low"
              type="checkbox"
              name="only_low"
              value="true"
              defaultChecked={filters.onlyLow}
              className="h-4 w-4 rounded border-slate-300 accent-pulse-600"
            />
            Ниже минимального остатка
          </label>
        </div>

        {/* Сброс фильтра приходит как пустая строка — backend трактует её как null. */}
        <input type="hidden" name="page" value="1" />
      </FilterBar>

      {loaderData.listError ? (
        <LoadError error={loaderData.listError} />
      ) : items.length === 0 ? (
        <EmptyState
          title="Товаров с такими условиями нет"
          hint="Измените фильтры или поиск."
        />
      ) : (
        <AdminTable
          caption="Остатки товаров"
          headers={[
            "Товар",
            "Артикул",
            "На складе",
            "В резерве",
            "Осталось",
            "Мин.",
            "Состояние",
            "Изменить",
          ]}
        >
          {items.map((item) => (
            <StockRow key={item.id} item={item} busy={busy} />
          ))}
        </AdminTable>
      )}

      {stock ? (
        <AdminPagination
          pathname="/admin/stock"
          search={searchParams}
          page={stock.page}
          pages={stock.pages}
          total={stock.total}
        />
      ) : null}
    </section>
  );
}

/**
 * Строка остатков с формой правки.
 *
 * Форма встроена в ячейку таблицы: HTML не позволяет форме пересекать границы
 * ячеек, а править количество нужно именно в строке товара.
 */
function StockRow({ item, busy }: { item: AdminStockItem; busy: boolean }) {
  const fieldId = `stock-available-${item.id}`;

  return (
    <tr>
      <AdminCell>
        <span className="font-medium text-slate-900">{item.name}</span>
        <span className="mt-0.5 block text-xs text-slate-600">
          {item.category_name}
          {item.brand_name ? ` · ${item.brand_name}` : ""}
        </span>
      </AdminCell>

      <AdminCell nowrap>
        <span className="text-slate-600">{item.sku}</span>
      </AdminCell>

      <AdminCell nowrap>
        <span className="text-slate-900">{item.stock_quantity}</span>
      </AdminCell>

      <AdminCell nowrap>
        <span className="text-slate-600">{item.reserved_quantity}</span>
      </AdminCell>

      <AdminCell nowrap>
        <span className={`font-semibold ${availableTone(item)}`}>{item.available_quantity}</span>
      </AdminCell>

      <AdminCell nowrap>
        {/* Точка заказа: ниже неё товар пора закупать. */}
        <span className="text-slate-600" title="Минимальный остаток — ниже него товар пора закупать">
          {item.min_stock}
        </span>
      </AdminCell>

      <AdminCell nowrap>
        <StatusBadge
          label={PRODUCT_STATUS_LABEL[item.availability] ?? item.availability}
          tone={statusTone(item.availability)}
        />
      </AdminCell>

      <AdminCell>
        <Form method="post" className="flex items-end gap-2">
          <input type="hidden" name="product_id" value={item.id} />

          <div className="w-24">
            <label htmlFor={fieldId} className="block text-xs font-medium text-slate-600">
              Осталось, шт
            </label>
            <input
              id={fieldId}
              name="available_quantity"
              type="number"
              min={0}
              step={1}
              defaultValue={item.available_quantity}
              className={`${ADMIN_INPUT} mt-1`}
            />
          </div>

          <div className="w-40">
            <label
              htmlFor={`stock-reason-${item.id}`}
              className="block text-xs font-medium text-slate-600"
            >
              Причина
            </label>
            <input
              id={`stock-reason-${item.id}`}
              name="reason"
              maxLength={200}
              placeholder="Поставка, брак, инвентаризация"
              className={`${ADMIN_INPUT} mt-1`}
            />
          </div>

          <ActionButton intent="set" tone="primary" busy={busy} busyLabel="Сохраняем…">
            Сохранить
          </ActionButton>
        </Form>
      </AdminCell>
    </tr>
  );
}
