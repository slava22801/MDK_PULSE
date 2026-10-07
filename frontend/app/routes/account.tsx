import { useEffect } from "react";
import { data, Form, redirect, useActionData } from "react-router";

import type { Route } from "./+types/account";

import type { AddressOut, OrderListResponse } from "~/lib/account";
import type { UserOut } from "~/lib/auth";
import { describeApiError } from "~/lib/api-error";
import { ApiError, serverFetch } from "~/lib/api.server";
import { clearAccessCookieHeader, readAccessToken } from "~/lib/auth-token";
import { ORDER_STATUS_TONE, PAYMENT_STATUS_LABEL, deliveryMethodLabel, orderStatusLabel } from "~/lib/order";
import { formatPrice, plural } from "~/lib/format";
import { useAuthStore } from "~/stores/auth";
import { FormField } from "~/widgets/form-field";
import { SiteHeader } from "~/widgets/site-header";

export function meta(): Route.MetaDescriptors {
  return [
    { title: "Личный кабинет — ПУЛЬС" },
    { name: "robots", content: "noindex" },
  ];
}

const ROLE_LABEL = {
  customer: "Покупатель",
  manager: "Менеджер",
  admin: "Администратор",
} as const satisfies Record<UserOut["role"], string>;

/**
 * Подписи статусов, способов доставки и оплаты живут в `~/lib/order`: их
 * используют и кабинет, и страница заказа, и чекаут. Держать вторую копию
 * значит через месяц показать в кабинете «Неизвестный статус», пока на странице
 * заказа он называется правильно.
 */

/** Раздел, который backend не отдал: показываем честный текст, а не заглушку. */
type Unavailable = { error: { message: string; status: number } };

function isUnavailable(value: AddressOut[] | OrderListResponse | Unavailable): value is Unavailable {
  return "error" in value;
}

function unavailable(cause: unknown, fallback: string): Unavailable {
  return { error: describeApiError(cause, fallback) };
}

/**
 * Проверка сессии до рендера: без неё страница отдавала бы кабинет всем,
 * кто умеет дописать /account в адресную строку.
 *
 * Токен берётся из cookie (сервер) либо из стора (клиентский переход — в
 * клиентском запросе заголовка Cookie нет, React Router его не подставляет).
 */
export async function loader({ request }: Route.LoaderArgs) {
  const token = readAccessToken(request, useAuthStore.getState().accessToken);
  if (!token) throw redirect("/login");

  const auth = { Authorization: `Bearer ${token}` };

  /**
   * Профиль читаем из `/auth/me`, а не из `GET /me`: поля у них одинаковые,
   * а `/auth/me` отвечает всегда — кабинет не должен зависеть от наличия
   * второго эндпоинта. Правки имени и телефона идут через `PATCH /me`,
   * как предписывает контракт.
   */
  let user: UserOut;
  try {
    user = await serverFetch<UserOut>("/auth/me", { headers: auth });
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401) {
      // Сессия протухла или отозвана: сбрасываем cookie, чтобы следующая
      // загрузка не пыталась авторизоваться снова.
      throw redirect("/login", { headers: { "Set-Cookie": clearAccessCookieHeader() } });
    }
    throw cause;
  }

  /**
   * Адреса и заказы грузим независимо: один недоступный раздел не должен
   * превращать весь кабинет в страницу ошибки.
   */
  const [addresses, orders] = await Promise.all([
    serverFetch<AddressOut[]>("/me/addresses", { headers: auth }).catch((cause: unknown) =>
      unavailable(cause, "Не удалось загрузить адреса"),
    ),
    serverFetch<OrderListResponse>("/me/orders?page=1&limit=10", { headers: auth }).catch(
      (cause: unknown) => unavailable(cause, "Не удалось загрузить заказы"),
    ),
  ]);

  return { user, addresses, orders };
}

export async function action({ request }: Route.ActionArgs) {
  const token = readAccessToken(request, useAuthStore.getState().accessToken);
  if (!token) throw redirect("/login");

  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const field = (name: string): string => String(form.get(name) ?? "").trim();

  try {
    if (intent === "profile") {
      // Пустые поля не отправляем: PATCH трактует отсутствие ключа как
      // «не менять», а пустую строку — как «очистить».
      await serverFetch<UserOut>("/me", {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({
          ...(field("first_name") ? { first_name: field("first_name") } : {}),
          ...(field("last_name") ? { last_name: field("last_name") } : {}),
          ...(field("phone") ? { phone: field("phone") } : {}),
        }),
      });
      // Перечитываем профиль, чтобы форма показала сохранённые значения, а не
      // то, что осталось в полях ввода.
      const user = await serverFetch<UserOut>("/auth/me", { headers: auth });
      return data({ intent, ok: "Профиль обновлён", user }, { status: 200 });
    }

    if (intent === "address.create") {
      await serverFetch<AddressOut>("/me/addresses", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          label: field("label") || null,
          recipient_name: field("recipient_name"),
          phone: field("phone"),
          city: field("city"),
          street: field("street"),
          building: field("building"),
          apartment: field("apartment") || null,
          postal_code: field("postal_code") || null,
          country: field("country") || "Россия",
          comment: field("comment") || null,
          is_default: form.get("is_default") === "on",
        }),
      });
      return data({ intent, ok: "Адрес сохранён" }, { status: 200 });
    }

    if (intent === "address.default") {
      await serverFetch<AddressOut>(`/me/addresses/${encodeURIComponent(field("address_id"))}`, {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({ is_default: true }),
      });
      return data({ intent, ok: "Адрес отмечен основным" }, { status: 200 });
    }

    if (intent === "address.delete") {
      await serverFetch<void>(`/me/addresses/${encodeURIComponent(field("address_id"))}`, {
        method: "DELETE",
        headers: auth,
      });
      return data({ intent, ok: "Адрес удалён" }, { status: 200 });
    }

    return data({ intent, error: "Неизвестное действие" }, { status: 400 });
  } catch (cause) {
    const info = describeApiError(cause, "Не удалось выполнить действие");
    return data({ intent, error: info.message, fields: info.fields }, { status: info.status || 400 });
  }
}

/** Ответ action'а: успех, ошибка и ошибки по полям формы. */
type ActionResult = {
  intent?: string;
  ok?: string;
  error?: string;
  fields?: Record<string, string>;
  user?: UserOut;
};

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("ru-RU");
}

export default function Account({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>() as ActionResult | undefined;
  const { addresses, orders } = loaderData;
  const setUser = useAuthStore((state) => state.setUser);

  // После правки профиля backend уже вернул свежего пользователя: подставляем
  // его и в стор, и в форму, иначе имя в шапке осталось бы прежним до
  // перезагрузки страницы.
  const user = actionData?.user ?? loaderData.user;

  useEffect(() => {
    setUser(user);
  }, [setUser, user]);

  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader authenticated />

      <main className="container-pulse flex-1 py-10 sm:py-14">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
          Личный кабинет
        </h1>
        <p className="mt-1.5 text-sm text-slate-600">
          Профиль, адреса доставки и история заказов.
        </p>

        <ActionFeedback result={actionData} />

        <ProfileSection user={user} result={actionData} />
        <AddressesSection addresses={addresses} result={actionData} />
        <OrdersSection orders={orders} />
      </main>
    </div>
  );
}

function ActionFeedback({ result }: { result: ActionResult | undefined }) {
  if (result?.ok) {
    return (
      <p
        role="status"
        className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-sm font-medium text-emerald-800"
      >
        {result.ok}
      </p>
    );
  }
  if (result?.error) {
    return (
      <p
        role="alert"
        className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm font-medium text-rose-700"
      >
        {result.error}
      </p>
    );
  }
  return null;
}

/* ──────────────────────────────── профиль ──────────────────────────────── */

function ProfileSection({ user, result }: { user: UserOut; result: ActionResult | undefined }) {
  const fields = result?.intent === "profile" ? (result.fields ?? {}) : {};

  return (
    <section aria-labelledby="profile-title" className="card mt-8 p-6">
      <h2 id="profile-title" className="text-lg font-semibold text-slate-900">
        Профиль
      </h2>

      <dl className="mt-4 grid gap-5 sm:grid-cols-2">
        <div>
          <dt className="text-sm text-slate-500">E-mail</dt>
          <dd className="mt-1 text-base font-medium break-all text-slate-900">{user.email}</dd>
        </div>
        <div>
          <dt className="text-sm text-slate-500">Роль</dt>
          <dd className="mt-1 text-base font-medium text-slate-900">{ROLE_LABEL[user.role]}</dd>
        </div>
        <div>
          <dt className="text-sm text-slate-500">Подтверждение e-mail</dt>
          <dd className="mt-1 flex items-center gap-2">
            <span
              aria-hidden="true"
              className={`h-2.5 w-2.5 rounded-full ${user.email_verified ? "bg-emerald-500" : "bg-amber-500"}`}
            />
            <span className="text-base font-medium text-slate-900">
              {user.email_verified ? "Подтверждён" : "Не подтверждён"}
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-sm text-slate-500">Дата регистрации</dt>
          <dd className="mt-1 text-base font-medium text-slate-900">
            {formatDateTime(user.created_at)}
          </dd>
        </div>
      </dl>

      <Form method="post" className="mt-6 border-t border-slate-200 pt-6">
        <input type="hidden" name="intent" value="profile" />
        <h3 className="text-base font-semibold text-slate-900">Изменить имя и телефон</h3>

        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          <FormField
            id="first_name"
            label="Имя"
            name="first_name"
            defaultValue={user.first_name}
            autoComplete="given-name"
            maxLength={64}
            error={fields.first_name}
          />
          <FormField
            id="last_name"
            label="Фамилия"
            name="last_name"
            defaultValue={user.last_name}
            autoComplete="family-name"
            maxLength={64}
            error={fields.last_name}
          />
          <FormField
            id="phone"
            label="Телефон"
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            defaultValue={user.phone ?? ""}
            placeholder="+7 900 000-00-00"
            error={fields.phone}
          />
        </div>

        <button
          type="submit"
          className="mt-4 rounded-xl bg-pulse-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-pulse-700"
        >
          Сохранить
        </button>
      </Form>
    </section>
  );
}

/* ──────────────────────────────── адреса ───────────────────────────────── */

function addressLine(address: AddressOut): string {
  return [
    address.city,
    address.street,
    `д. ${address.building}`,
    address.apartment ? `кв. ${address.apartment}` : null,
    address.postal_code,
  ]
    .filter(Boolean)
    .join(", ");
}

function AddressesSection({
  addresses,
  result,
}: {
  addresses: AddressOut[] | Unavailable;
  result: ActionResult | undefined;
}) {
  const fields = result?.intent?.startsWith("address.") ? (result.fields ?? {}) : {};

  return (
    <section aria-labelledby="addresses-title" className="card mt-6 p-6">
      <h2 id="addresses-title" className="text-lg font-semibold text-slate-900">
        Адреса доставки
      </h2>

      {isUnavailable(addresses) ? (
        <p className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-3 text-sm text-amber-900">
          Список адресов сейчас недоступен: {addresses.error.message}
        </p>
      ) : addresses.length === 0 ? (
        <p className="mt-3 text-sm text-slate-600">
          Сохранённых адресов пока нет. Добавьте адрес — его можно будет выбрать при оформлении заказа.
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {addresses.map((address) => (
            <li key={address.id} className="rounded-xl border border-slate-200 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium text-slate-900">
                    {address.label ?? address.recipient_name}
                    {address.is_default ? (
                      <span className="rounded-lg bg-pulse-100 px-2 py-0.5 text-xs font-bold text-pulse-800">
                        Основной
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-1 text-sm text-slate-700">{addressLine(address)}</p>
                  <p className="mt-1 text-sm text-slate-600">
                    {address.recipient_name}
                    {address.phone ? ` · ${address.phone}` : ""}
                    {address.country ? ` · ${address.country}` : ""}
                  </p>
                  {address.comment ? (
                    <p className="mt-1 text-sm text-slate-500">Комментарий: {address.comment}</p>
                  ) : null}
                </div>

                <div className="flex flex-wrap gap-2">
                  {!address.is_default ? (
                    <Form method="post">
                      <input type="hidden" name="intent" value="address.default" />
                      <input type="hidden" name="address_id" value={address.id} />
                      <button
                        type="submit"
                        className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
                      >
                        Сделать основным
                      </button>
                    </Form>
                  ) : null}
                  <Form method="post">
                    <input type="hidden" name="intent" value="address.delete" />
                    <input type="hidden" name="address_id" value={address.id} />
                    <button
                      type="submit"
                      className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-rose-600 transition-colors hover:border-rose-300"
                    >
                      Удалить
                    </button>
                  </Form>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <details className="mt-5 rounded-xl border border-slate-200">
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-900">
          Добавить адрес
        </summary>

        <Form method="post" className="space-y-4 border-t border-slate-200 p-4">
          <input type="hidden" name="intent" value="address.create" />

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              id="address-label"
              label="Метка"
              name="label"
              placeholder="Дом, Работа"
              hint="Необязательно: так адрес проще отличить в списке."
              maxLength={64}
              error={fields.label}
            />
            <FormField
              id="address-recipient"
              label="Получатель"
              name="recipient_name"
              autoComplete="name"
              required
              maxLength={128}
              error={fields.recipient_name}
            />
            <FormField
              id="address-phone"
              label="Телефон"
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              required
              error={fields.phone}
            />
            <FormField
              id="address-city"
              label="Город"
              name="city"
              autoComplete="address-level2"
              required
              maxLength={128}
              error={fields.city}
            />
            <FormField
              id="address-street"
              label="Улица"
              name="street"
              autoComplete="address-line1"
              required
              maxLength={256}
              error={fields.street}
            />
            <FormField
              id="address-building"
              label="Дом"
              name="building"
              required
              maxLength={16}
              error={fields.building}
            />
            <FormField
              id="address-apartment"
              label="Квартира"
              name="apartment"
              maxLength={16}
              error={fields.apartment}
            />
            <FormField
              id="address-postal"
              label="Индекс"
              name="postal_code"
              inputMode="numeric"
              autoComplete="postal-code"
              maxLength={16}
              error={fields.postal_code}
            />
            <FormField
              id="address-country"
              label="Страна"
              name="country"
              defaultValue="Россия"
              autoComplete="country-name"
              maxLength={128}
              error={fields.country}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="address-comment" className="block text-sm font-medium text-slate-800">
              Комментарий
            </label>
            <textarea
              id="address-comment"
              name="comment"
              rows={2}
              maxLength={500}
              placeholder="Домофон, код домофона, «позвонить за час»"
              className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-base text-slate-900 placeholder:text-slate-400"
            />
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-slate-800">
              <input
                type="checkbox"
                name="is_default"
                className="h-4 w-4 rounded border-slate-300 text-pulse-600"
              />
              Сделать основным адресом
            </label>

            <button
              type="submit"
              className="rounded-xl bg-pulse-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-pulse-700"
            >
              Сохранить адрес
            </button>
          </div>
        </Form>
      </details>
    </section>
  );
}

/* ──────────────────────────────── заказы ───────────────────────────────── */

function OrdersSection({ orders }: { orders: OrderListResponse | Unavailable }) {
  return (
    <section aria-labelledby="orders-title" className="card mt-6 p-6">
      <h2 id="orders-title" className="text-lg font-semibold text-slate-900">
        История заказов
      </h2>

      {isUnavailable(orders) ? (
        <p className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-3 text-sm text-amber-900">
          Список заказов сейчас недоступен: {orders.error.message}
        </p>
      ) : orders.items.length === 0 ? (
        <div className="mt-3">
          <p className="text-sm text-slate-700">
            Заказов пока нет — это пустая история покупок, а не сбой. Как только оформите первый заказ,
            он появится здесь.
          </p>
          <a
            href="/catalog"
            className="mt-4 inline-block rounded-xl bg-pulse-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-pulse-700"
          >
            Перейти в каталог
          </a>
        </div>
      ) : (
        <>
          <ul className="mt-4 space-y-3">
            {orders.items.map((order) => (
              <li key={order.id} className="rounded-xl border border-slate-200 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-medium text-slate-900">
                      {order.order_number}
                      <span
                        className={`rounded-lg px-2 py-0.5 text-xs font-bold ${
                          ORDER_STATUS_TONE[order.status] ?? "bg-slate-200 text-slate-700"
                        }`}
                      >
                        {orderStatusLabel(order.status)}
                      </span>
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {formatDateTime(order.created_at)}
                      {order.delivery_method
                        ? ` · ${deliveryMethodLabel(order.delivery_method)}`
                        : ""}
                      {order.tracking_number ? ` · трек ${order.tracking_number}` : ""}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-base font-bold text-slate-900">
                      {formatPrice(order.total_amount)}
                    </p>
                    <p className="text-xs text-slate-500">
                      {order.items_count} {plural(order.items_count, "товар", "товара", "товаров")}
                    </p>
                  </div>
                </div>

                {order.payment_status !== order.status ? (
                  <p className="mt-2 text-xs text-slate-600">
                    Оплата: {PAYMENT_STATUS_LABEL[order.payment_status] ?? order.payment_status}
                  </p>
                ) : null}

                {/*
                  Подробности — обычная ссылка, а не `<Link>`: loader
                  `/order/:orderId` ходит в backend через serverFetch, которого
                  в браузере нет.
                */}
                <div className="mt-3 flex flex-wrap gap-2">
                  <a
                    href={`/order/${order.id}`}
                    className="rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 transition-colors hover:border-pulse-400 hover:text-pulse-700"
                  >
                    Подробнее
                  </a>
                  {order.status !== "completed" && order.status !== "cancelled" ? (
                    <a
                      href="/catalog"
                      className="rounded-xl px-3.5 py-2 text-sm font-semibold text-pulse-600 transition-colors hover:text-pulse-700"
                    >
                      Докупить товары
                    </a>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>

          <p className="mt-4 text-sm text-slate-600">
            Показаны заказы {orders.page}-й страницы из {orders.pages} · всего {orders.total}{" "}
            {plural(orders.total, "заказ", "заказа", "заказов")}
          </p>
        </>
      )}
    </section>
  );
}