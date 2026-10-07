import { data, Form, useActionData, useNavigation, useSearchParams } from "react-router";

import type { Route } from "./+types/orders";

import type { AdminOrderDetail, AdminOrderListItem, AdminPage } from "~/lib/admin";
import type { ApiErrorInfo } from "~/lib/api-error";
import { describeApiError } from "~/lib/api-error";
import { serverFetch } from "~/lib/api.server";
import { queryString, requireAdminSession } from "~/lib/admin.server";
import {
  ORDER_STATUS_LABEL,
  deliveryMethodLabel,
  orderStatusLabel,
  paymentStatusLabel,
} from "~/lib/order";
import {
  formatDateTime,
  parseAllowedTransitions,
  parseLimit,
  parsePage,
  parseStatusFilter,
} from "~/lib/admin";
import { formatPrice } from "~/lib/format";
import {
  ADMIN_INPUT,
  ActionButton,
  AdminCell,
  AdminField,
  AdminNotice,
  AdminPagination,
  AdminTable,
  AdminTextarea,
  DateCell,
  EmptyState,
  FilterBar,
  FilterField,
  LoadError,
  MoneyCell,
  StatusBadge,
  statusTone,
} from "~/widgets/admin-ui";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Заказы — Админ-панель — ПУЛЬС" }];
}

/**
 * Заказы: список с фильтрами и карточка заказа.
 *
 * Раздел доступен менеджеру и администратору (ТЗ 3.3/3.4) — проверка роли в
 * `requireAdminSession`, а не в разметке.
 *
 * Список и карточка разделены по `?order=<id>`: это позволяет ссылаться на
 * конкретный заказ, возвращаться к списку кнопкой «Назад» и держать фильтры
 * в URL, не заводия отдельный маршрут `/admin/orders/:id` на каждое действие.
 */

/** Фильтры в URL — единственный источник: форма и loader читают одно и то же. */
type OrderFilters = {
  search: string;
  status: string;
  dateFrom: string;
  dateTo: string;
  page: number;
  limit: number;
};

function readFilters(url: URL): OrderFilters {
  return {
    search: (url.searchParams.get("search") ?? "").trim(),
    status: parseStatusFilter(url.searchParams.get("status")),
    dateFrom: (url.searchParams.get("date_from") ?? "").trim(),
    dateTo: (url.searchParams.get("date_to") ?? "").trim(),
    page: parsePage(url.searchParams.get("page")),
    limit: parseLimit(url.searchParams.get("limit")),
  };
}

/** Ответ action'а: сообщение и — для смены статуса — разрешённые переходы. */
type OrderActionResult = {
  ok?: string;
  error?: string;
  errorCode?: string;
  fields?: Record<string, string>;
  /** `fields.allowed` из 409 `invalid_status_transition`. */
  allowed?: string[];
  orderId?: string;
};

export async function loader({ request }: Route.LoaderArgs) {
  const session = await requireAdminSession(request, { section: "orders" });
  const url = new URL(request.url);
  const filters = readFilters(url);

  // `order` в URL открывает карточку; без него грузим только список.
  const orderId = url.searchParams.get("order");

  const listPromise = serverFetch<AdminPage<AdminOrderListItem>>(
    `/admin/orders${queryString({
      page: filters.page,
      limit: filters.limit,
      search: filters.search,
      status: filters.status,
      date_from: filters.dateFrom || undefined,
      date_to: filters.dateTo || undefined,
    })}`,
    { headers: session.headers },
  ).catch((cause: unknown) => cause as ApiErrorInfo);

  const detailPromise = orderId
    ? serverFetch<AdminOrderDetail>(`/admin/orders/${encodeURIComponent(orderId)}`, {
        headers: session.headers,
      }).catch((cause: unknown) => cause as ApiErrorInfo)
    : Promise.resolve(null);

  const [list, detail] = await Promise.all([listPromise, detailPromise]);

  // Ошибку списка превращаем в состояние, а не бросаем: карточка заказа при
  // этом остаётся рабочей — сломанный фильтр не должен отнимать возможность
  // открыть заказ по прямой ссылке.
  const listError =
    list instanceof Error ? describeApiError(list, "Не удалось загрузить заказы") : null;
  const detailError =
    detail instanceof Error ? describeApiError(detail, "Не удалось загрузить заказ") : null;

  return {
    user: session.user,
    filters,
    orders: listError ? null : (list as AdminPage<AdminOrderListItem>),
    listError,
    order: detailError ? null : (detail as AdminOrderDetail | null),
    detailError,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const session = await requireAdminSession(request, { section: "orders" });

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const field = (name: string): string => String(form.get(name) ?? "").trim();
  const orderId = field("order_id");

  if (!orderId) {
    return data<OrderActionResult>(
      { error: "Не указан заказ", errorCode: "missing_order_id" },
      { status: 400 },
    );
  }

  try {
    if (intent === "status") {
      const status = field("status");
      if (!status) {
        return data<OrderActionResult>(
          { error: "Выберите статус", errorCode: "status_required", orderId },
          { status: 400 },
        );
      }

      // Трек-номер едет ВМЕСТЕ со сменой статуса, и это не совпадение.
      // Живой проверкой установлено: `PATCH` с одним только `tracking_number`
      // backend проводит через ту же статусную машину (`to = текущий статус`),
      // а перехода «сам в себя» в матрице нет — такой запрос всегда даёт 409
      // `invalid_status_transition`. Записать трек-номер можно только вместе
      // с реальным переходом, поэтому поля объединены в одну форму.
      const payload: { status: string; tracking_number?: string } = { status };
      const tracking = field("tracking_number");
      if (tracking !== "") payload.tracking_number = tracking;

      await serverFetch<AdminOrderDetail>(`/admin/orders/${encodeURIComponent(orderId)}`, {
        method: "PATCH",
        headers: session.jsonHeaders,
        body: JSON.stringify(payload),
      });
      return data<OrderActionResult>(
        {
          ok: tracking ? `Статус изменён: ${orderStatusLabel(status)}, трек-номер сохранён` : `Статус изменён: ${orderStatusLabel(status)}`,
          orderId,
        },
        { status: 200 },
      );
    }

    if (intent === "manager_comment") {
      const comment = field("manager_comment");
      if (!comment) {
        return data<OrderActionResult>(
          { error: "Введите комментарий", errorCode: "comment_required", orderId },
          { status: 400 },
        );
      }

      // Эндпоинт принимает `Form(min_length=1)`, а не JSON: живая проверка
      // показала, что тело обязано быть form-encoded. Отдельный FormData
      // поэтому не даёт задавать `Content-Type` — boundary выставляет fetch.
      const body = new FormData();
      body.set("comment", comment);

      await serverFetch<AdminOrderDetail>(`/admin/orders/${encodeURIComponent(orderId)}/comment`, {
        method: "POST",
        headers: session.headers,
        body,
      });
      return data<OrderActionResult>({ ok: "Комментарий добавлен", orderId }, { status: 200 });
    }

    return data<OrderActionResult>(
      { error: "Неизвестное действие", errorCode: "unknown_intent", orderId },
      { status: 400 },
    );
  } catch (cause) {
    const info = describeApiError(cause, "Не удалось выполнить действие с заказом");
    return data<OrderActionResult>(
      {
        error: orderErrorMessage(info),
        errorCode: info.code,
        fields: info.fields,
        orderId,
        // `fields.allowed` — список разрешённых переходов, который backend
        // кладёт в 409 `invalid_status_transition`. Без него форма предлагала бы
        // заведомо нерабочие статусы и сотрудник не понял бы, что делать.
        allowed:
          info.code === "invalid_status_transition"
            ? parseAllowedTransitions(info.fields.allowed)
            : [],
      },
      { status: info.status >= 400 && info.status < 500 ? info.status : 400 },
    );
  }
}

/**
 * Текст ошибки заказа.
 *
 * Для 409 `invalid_status_transition` показываем дословный текст сервера: он
 * уже содержит и текущий, и разрешённые статусы, а своя формулировка бы
 * отстала от бизнес-правил. Остальные коды переводим в человеческий вид.
 */
function orderErrorMessage(info: ApiErrorInfo): string {
  switch (info.code) {
    case "invalid_status_transition":
      return info.message;
    case "insufficient_stock":
    case "product_in_orders":
      return info.message;
    case "insufficient_role":
      return "Раздел доступен только администратору.";
    case "validation_error":
      return info.message;
    case "network_error":
      return "Сервер недоступен. Проверьте соединение и повторите действие.";
    default:
      return info.status >= 500
        ? "Сервер временно недоступен, действие не выполнено. Повторите через минуту."
        : info.message;
  }
}

export default function AdminOrders({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>() as OrderActionResult | undefined;
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const { filters, orders, listError, order, detailError } = loaderData;

  const busy = navigation.state !== "idle";
  const currentSearch = new URLSearchParams(searchParams);

  /**
   * Ссылка на карточку заказа сохраняет активные фильтры и сбрасывает страницу:
   * иначе после возврата к списку сотрудник оказывался бы на 4-й странице
   * фильтра, которого уже нет. `order` кладём в тот же URL, поэтому <Link>
   * работает без перезагрузки — loader перечитает данные на сервере.
   */
  const orderHref = (orderId: string): string => {
    const next = new URLSearchParams(currentSearch);
    next.delete("page");
    next.set("order", orderId);
    return `/admin/orders?${next.toString()}`;
  };

  /**
   * Обратно к списку: карточка закрыта, фильтры остаются на месте.
   *
   * Из URL убираем `order` — иначе карточка открылась бы снова после F5.
   */
  const backHref = ((): string => {
    const next = new URLSearchParams(currentSearch);
    next.delete("order");
    const query = next.toString();
    return query ? `/admin/orders?${query}` : "/admin/orders";
  })();

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Заказы</h1>
          <p className="mt-1 text-sm text-slate-600">
            Поиск по номеру, имени и телефону. Статусы меняются по правилам, которые
            присылает сервер.
          </p>
        </div>
        <PrintButton />
      </div>

      <AdminNotice
        ok={actionData?.ok}
        error={actionData?.error}
        errorCode={actionData?.errorCode}
      >
        {actionData?.allowed && actionData.allowed.length > 0 ? (
          <p className="mt-2">
            Разрешённые переходы:{" "}
            <span className="font-semibold">{actionData.allowed.join(" → ")}</span>
          </p>
        ) : null}
      </AdminNotice>

      <FilterBar action="/admin/orders">
        <FilterField id="orders-search" label="Поиск">
          <input
            id="orders-search"
            type="search"
            name="search"
            defaultValue={filters.search}
            placeholder="Номер, имя, телефон"
            className={ADMIN_INPUT}
          />
        </FilterField>

        <FilterField id="orders-status" label="Статус">
          <select id="orders-status" name="status" defaultValue={filters.status} className={ADMIN_INPUT}>
            <option value="">Все статусы</option>
            {Object.entries(ORDER_STATUS_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </FilterField>

        <FilterField id="orders-from" label="С даты">
          <input
            id="orders-from"
            type="date"
            name="date_from"
            defaultValue={filters.dateFrom}
            className={ADMIN_INPUT}
          />
        </FilterField>

        <FilterField id="orders-to" label="По дату">
          <input
            id="orders-to"
            type="date"
            name="date_to"
            defaultValue={filters.dateTo}
            className={ADMIN_INPUT}
          />
        </FilterField>

        <input type="hidden" name="limit" value={String(filters.limit)} />

        <button
          type="submit"
          className="rounded-xl bg-pulse-600 px-4 py-2 text-sm font-semibold text-white hover:bg-pulse-700"
        >
          Применить
        </button>
        <a
          href="/admin/orders"
          className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Сбросить
        </a>
      </FilterBar>

      {listError ? (
        <div className="mt-5">
          <LoadError error={listError} />
        </div>
      ) : orders && orders.items.length > 0 ? (
        <AdminTable
          caption="Список заказов"
          headers={["Номер", "Покупатель", "Статус", "Оплата", "Сумма", "Создан", "Действия"]}
        >
          {orders.items.map((item) => (
            <tr key={item.id} className="hover:bg-slate-50">
              <AdminCell nowrap>
                <a
                  href={orderHref(item.id)}
                  className="font-semibold text-pulse-700 hover:underline"
                >
                  {item.order_number}
                </a>
              </AdminCell>
              <AdminCell>
                <p className="font-medium text-slate-900">{item.customer_full_name}</p>
                <p className="text-xs text-slate-600">
                  {item.customer_email} · {item.customer_phone}
                </p>
              </AdminCell>
              <AdminCell nowrap>
                <StatusBadge
                  label={orderStatusLabel(item.status, item.status_label)}
                  tone={statusTone(item.status)}
                />
              </AdminCell>
              <AdminCell nowrap>
                <span className="text-xs text-slate-600">
                  {paymentStatusLabel(item.payment_status)}
                </span>
              </AdminCell>
              <AdminCell nowrap>
                <MoneyCell value={item.total_amount} />
              </AdminCell>
              <AdminCell nowrap>
                <DateCell value={item.created_at} />
              </AdminCell>
              <AdminCell nowrap>
                <a
                  href={orderHref(item.id)}
                  className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  Открыть
                </a>
              </AdminCell>
            </tr>
          ))}
        </AdminTable>
      ) : (
        <div className="mt-5">
          <EmptyState
            title="Заказы не найдены"
            hint="Попробуйте снять фильтры или изменить поисковый запрос."
          />
        </div>
      )}

      {orders ? (
        <AdminPagination
          pathname="/admin/orders"
          search={currentSearch}
          page={orders.page}
          pages={orders.pages}
          total={orders.total}
        />
      ) : null}

      {order ? (
        <>
          <a
            href={backHref}
            className="mt-6 inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            ← Назад к списку
          </a>
          <OrderCard order={order} busy={busy} />
        </>
      ) : detailError ? (
        <div className="mt-8">
          <LoadError error={detailError} />
        </div>
      ) : null}
    </>
  );
}

/**
 * Кнопка печати.
 *
 * `window.print()` в обработчике клика, а не в форме: печать не меняет данные,
 * поэтому она не должна проходить через action и ждать ответа сервера.
 * Без JS кнопка просто не появляется — печать из раздела не обязательна.
 */
function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => {
        if (typeof window !== "undefined") window.print();
      }}
      className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
    >
      Печать
    </button>
  );
}

/**
 * Карточка заказа: состав, адрес, смена статуса, трек-номер, комментарий.
 *
 * Отдельная форма на каждое действие, а не одна большая: у них разные наборы
 * полей, и общая форма означала бы, что смена статуса заодно перезаписывает
 * пустой трек-номером поле, которое менеджер не трогал.
 */
function OrderCard({ order, busy }: { order: AdminOrderDetail; busy: boolean }) {
  const address = order.delivery_address;

  return (
    <section aria-labelledby="order-card" className="card mt-8 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="order-card" className="text-lg font-semibold text-slate-900">
            Заказ {order.order_number}
          </h2>
          <p className="mt-1 text-sm text-slate-600">Создан {formatDateTime(order.created_at)}</p>
        </div>
        <StatusBadge
          label={orderStatusLabel(order.status, order.status_label)}
          tone={statusTone(order.status)}
        />
      </div>

      <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <p className="text-sm text-slate-500">Покупатель</p>
          <p className="mt-1 text-sm font-medium text-slate-900">
            {order.customer_first_name} {order.customer_last_name}
          </p>
          <p className="text-sm text-slate-700">{order.customer_email}</p>
          <p className="text-sm text-slate-700">{order.customer_phone}</p>
        </div>

        <div>
          <p className="text-sm text-slate-500">Доставка</p>
          <p className="mt-1 text-sm font-medium text-slate-900">
            {deliveryMethodLabel(order.delivery_method)}
          </p>
          {address ? (
            <p className="text-sm text-slate-700">
              {address.city}, {address.street}, д. {address.building}
              {address.apartment ? `, кв. ${address.apartment}` : ""}
            </p>
          ) : (
            <p className="text-sm text-slate-500">Адрес не указан (самовывоз)</p>
          )}
          <p className="text-sm text-slate-600">
            Оплата: {paymentStatusLabel(order.payment_status)}
          </p>
        </div>

        <div>
          <p className="text-sm text-slate-500">Сумма</p>
          <p className="mt-1 text-sm text-slate-700">
            Товары: {formatPrice(order.subtotal)}
          </p>
          <p className="text-sm text-slate-700">Скидка: {formatPrice(order.discount_amount)}</p>
          <p className="text-sm text-slate-700">Доставка: {formatPrice(order.delivery_cost)}</p>
          <p className="mt-1 text-base font-bold text-slate-900">
            Итого: {formatPrice(order.total_amount)}
          </p>
          {order.promo_code ? (
            <p className="mt-1 text-xs text-slate-600">Промокод: {order.promo_code}</p>
          ) : null}
        </div>
      </div>

      {order.comment ? (
        <p className="mt-4 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-700">
          Комментарий покупателя: {order.comment}
        </p>
      ) : null}

      <OrderItems order={order} />

      <div className="mt-6 grid gap-6 border-t border-slate-200 pt-6 lg:grid-cols-2">
        <div className="space-y-4">
          <OrderStatusForm order={order} busy={busy} />
          <div className="flex flex-wrap gap-2">
            <OrderCancelForm order={order} busy={busy} />
          </div>
        </div>
        <OrderCommentForm order={order} busy={busy} />
      </div>

      {order.manager_comment ? (
        <p className="mt-4 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Внутренний комментарий: {order.manager_comment}
        </p>
      ) : null}
    </section>
  );
}

function OrderItems({ order }: { order: AdminOrderDetail }) {
  if (order.items.length === 0) {
    return (
      <div className="mt-5">
        <EmptyState title="Состав заказа пуст" hint="Позиции не найдены в базе." />
      </div>
    );
  }

  return (
    <AdminTable
      caption="Состав заказа"
      headers={["Товар", "Артикул", "Кол-во", "Цена", "Сумма"]}
    >
      {order.items.map((item) => (
        <tr key={item.id}>
          <AdminCell>
            <span className="font-medium text-slate-900">{item.product_name}</span>
          </AdminCell>
          <AdminCell nowrap>
            <span className="text-slate-600">{item.sku}</span>
          </AdminCell>
          <AdminCell nowrap>{item.quantity}</AdminCell>
          <AdminCell nowrap>
            <MoneyCell value={item.price} />
          </AdminCell>
          <AdminCell nowrap>
            <MoneyCell value={item.total_price} />
          </AdminCell>
        </tr>
      ))}
    </AdminTable>
  );
}

/**
 * Смена статуса.
 *
 * Список переходов НЕ зашит в форму: backend возвращает 409
 * `invalid_status_transition` с `fields.allowed`, и именно эти значения мы
 * подставляем в `<select>` после неудачной попытки. Своя таблица переходов
 * разошлась бы с серверной (отменённый заказ разрешает возврат, возвращённый —
 * ничего), и сотрудник увидел бы неработающие варианты.
 *
 * До первой неудачи доступны все статусы: заранее знать разрешённые переходы
 * фронт не может, а лишняя попытка безопасна — сервер просто объяснит.
 */
function OrderStatusForm({ order, busy }: { order: AdminOrderDetail; busy: boolean }) {
  const actionData = useActionData<typeof action>() as OrderActionResult | undefined;

  // Ответ 409 относится к текущей карточке: чужой заказ не должен подменять
  // список переходов открытого.
  const allowed =
    actionData?.orderId === order.id && actionData.allowed && actionData.allowed.length > 0
      ? actionData.allowed
      : null;

  return (
    <Form method="post" className="space-y-3">
      <input type="hidden" name="order_id" value={order.id} />

      <AdminField
        id="order-status"
        label="Статус заказа"
        hint={
          allowed
            ? "Список переходов пришёл с сервера после отказа."
            : "Если статус недопустим, сервер покажет разрешённые переходы."
        }
      >
        <select id="order-status" name="status" className={ADMIN_INPUT} defaultValue={order.status}>
          {allowed
            ? allowed.map((value) => (
                <option key={value} value={value}>
                  {orderStatusLabel(value)}
                </option>
              ))
            : Object.entries(ORDER_STATUS_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
        </select>
      </AdminField>

      <AdminField
        id="order-tracking"
        label="Трек-номер"
        hint="Сохраняется вместе со сменой статуса — отдельно сервер его не примет."
      >
        <input
          id="order-tracking"
          name="tracking_number"
          defaultValue={order.tracking_number ?? ""}
          maxLength={100}
          className={ADMIN_INPUT}
        />
      </AdminField>

      <div className="flex flex-wrap gap-2">
        <ActionButton intent="status" tone="primary" busy={busy} busyLabel="Меняем…">
          Изменить статус
        </ActionButton>
      </div>
    </Form>
  );
}

/**
 * Отмена заказа.
 *
 * Отдельная форма, а не значение в списке статусов: отмена — необратимое
 * действие с возвратом остатков, поэтому у неё своё подтверждение и она
 * показывается только когда backend разрешил (`can_cancel`). Флаг держим
 * серверный намеренно — правило «когда можно отменить» меняется вместе с
 * бизнес-процессом, и клиентская копия этого правила устарела бы первой.
 */
function OrderCancelForm({ order, busy }: { order: AdminOrderDetail; busy: boolean }) {
  if (!order.can_cancel) return null;

  return (
    <Form
      method="post"
      onSubmit={(event) => {
        // Подтверждение нужно только с JS: без него форма всё равно уходит на
        // сервер, а backend откажет, если отмена запрещена для этого статуса.
        if (!window.confirm(`Отменить заказ ${order.order_number}? Действие вернёт остатки товаров на склад.`)) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="order_id" value={order.id} />
      <ActionButton intent="status" tone="danger" busy={busy} busyLabel="Отменяем…">
        Отменить заказ
      </ActionButton>
      {/* Кнопка отправляет не intent, а статус: action один на оба действия. */}
      <input type="hidden" name="status" value="cancelled" />
    </Form>
  );
}

/**
 * Комментарий менеджера.
 *
 * Поле намеренно пустое, а не с текущим значением: эндпоинт `/comment`
 * ДОБАВЛЯЕТ строку к истории комментариев, а не заменяет её. Предзаполненное
 * поле отправило бы старый текст повторно и размножило бы его в истории.
 */
function OrderCommentForm({ order, busy }: { order: AdminOrderDetail; busy: boolean }) {
  return (
    <Form method="post" className="space-y-3">
      <input type="hidden" name="order_id" value={order.id} />
      <AdminField
        id="order-comment"
        label="Комментарий менеджера"
        hint="Виден только сотрудникам. Добавляется к истории заказа."
      >
        <AdminTextarea
          id="order-comment"
          name="manager_comment"
          rows={4}
          maxLength={1000}
          placeholder="Например: перенос доставки на 12.10"
        />
      </AdminField>
      <ActionButton intent="manager_comment" busy={busy} busyLabel="Сохраняем…">
        Добавить комментарий
      </ActionButton>
    </Form>
  );
}

