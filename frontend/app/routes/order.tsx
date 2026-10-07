import type { Route } from "./+types/order";

import { data, Form, redirect, useActionData } from "react-router";

import type { ApiErrorInfo } from "~/lib/api-error";
import type { OrderOut, PaymentStartResponse } from "~/lib/order";
import { describeApiError } from "~/lib/api-error";
import { ApiError, serverFetch } from "~/lib/api.server";
import { readAccessToken, clearAccessCookieHeader } from "~/lib/auth-token";
import { addressLine, deliveryMethodLabel, orderStatusLabel, paymentMethodLabel, paymentStatusLabel } from "~/lib/order";
import { formatPrice, plural } from "~/lib/format";
import { useAuthStore } from "~/stores/auth";
import { SiteHeader } from "~/widgets/site-header";

export function meta({ data }: Route.MetaArgs): Route.MetaDescriptors {
  const order = data?.state === "ok" ? data.order : null;
  return [
    { title: order ? `Заказ ${order.order_number} — ПУЛЬС` : "Заказ — ПУЛЬС" },
    { name: "robots", content: "noindex" },
  ];
}

/**
 * Страница заказа `/order/:orderId` — раздел 5.11 ТЗ.
 *
 * Три действия, и все три неочевидны по последствиям, поэтому у каждого
 * свой `intent` у action'а:
 *  - «Оплатить» ведёт на страницу фейкового провайдера;
 *  - «Повторить заказ» возвращает позиции в корзину;
 *  - «Отменить заказ» необратим, поэтому вторая кнопка (подтверждение)
 *    отдельным шагом — иначе один промах по кнопке отменял бы заказ.
 *
 * Гостю заказ недоступен: `GET /orders/{id}` отдаёт 404, если заказ не его
 * (проверено живым запросом — гостевой заказ не привязан к пользователю).
 * Поэтому вместо ошибки 404 показываем честное объяснение, а не «страница не
 * найдена».
 */

const NOTICES: Record<string, string> = {
  cancelled: "Заказ отменён.",
  reordered: "Товары из заказа вернулись в корзину.",
  paid: "Оплата подтверждена.",
};

/** Статусы, из которых заказ уже нельзя оплатить (проверка — на бэке). */
const PAYABLE_STATUSES = new Set(["new", "confirmed", "awaiting_payment"]);

export async function loader({ request, params }: Route.LoaderArgs) {
  const token = readAccessToken(request, useAuthStore.getState().accessToken);
  const authenticated = Boolean(token);
  const orderId = params.orderId ?? "";
  const url = new URL(request.url);

  if (!token) {
    return { state: "guest" as const, authenticated, notice: url.searchParams.get("notice") };
  }

  const headers = { Authorization: `Bearer ${token}` };

  try {
    const order = await serverFetch<OrderOut>(`/orders/${encodeURIComponent(orderId)}`, { headers });
    return {
      state: "ok" as const,
      authenticated,
      order,
      placed: url.searchParams.get("placed") === "1",
      notice: url.searchParams.get("notice"),
    };
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401) {
      // Токен протух: чистим cookie, иначе следующая загрузка снова попытается
      // авторизоваться мёртвым токеном.
      throw redirect("/login", { headers: { "Set-Cookie": clearAccessCookieHeader() } });
    }
    const error = describeApiError(cause, "Не удалось загрузить заказ");
    if (cause instanceof ApiError && cause.status === 404) {
      return { state: "missing" as const, authenticated, notice: url.searchParams.get("notice") };
    }
    return { state: "error" as const, authenticated, error, notice: url.searchParams.get("notice") };
  }
}

type OrderActionResult = {
  intent: string;
  /** Панель подтверждения отмены: показывается только после первого нажатия. */
  confirmCancel: boolean;
  error: string | null;
  errorCode: string | null;
};

export async function action({ request, params }: Route.ActionArgs) {
  const token = readAccessToken(request, useAuthStore.getState().accessToken);
  if (!token) throw redirect("/login");

  const orderId = params.orderId ?? "";
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  function fail(error: ApiErrorInfo) {
    return data(
      { intent, confirmCancel: false, error: error.message, errorCode: error.code },
      { status: error.status > 0 && error.status < 500 ? error.status : 400 },
    );
  }

  if (intent === "cancel_confirm") {
    // Шаг подтверждения: ничего не отправляем, только показываем вопрос.
    return data(
      { intent, confirmCancel: true, error: null, errorCode: null },
      { status: 200 },
    );
  }

  try {
    if (intent === "cancel") {
      try {
        await serverFetch<OrderOut>(`/orders/${encodeURIComponent(orderId)}/cancel`, {
          method: "POST",
          headers,
        });
      } catch (cause) {
        const info = describeApiError(cause, "Не удалось отменить заказ");
        // 409 `order_not_cancellable` — это не сбой, а «уже поздно»: текст
        // backend-а объясняет, что заказ уехал в сборку.
        return data(
          {
            intent,
            confirmCancel: false,
            error:
              info.code === "order_not_cancellable"
                ? "Отменить уже нельзя: заказ перешёл в сборку. Свяжитесь с менеджером."
                : info.message,
            errorCode: info.code,
          },
          { status: info.status > 0 && info.status < 500 ? info.status : 400 },
        );
      }
      throw redirect(`/order/${orderId}?notice=cancelled`);
    }

    if (intent === "reorder") {
      await serverFetch<{ message: string }>(`/orders/${encodeURIComponent(orderId)}/reorder`, {
        method: "POST",
        headers,
      });
      throw redirect(`/order/${orderId}?notice=reordered`);
    }

    if (intent === "pay") {
      const payment = await serverFetch<PaymentStartResponse>(`/orders/${encodeURIComponent(orderId)}/payment`, {
        method: "POST",
        headers,
      });
      // `redirect_url` фейкового провайдера — это наш же `/payment/{id}?token=…`.
      if (!payment.redirect_url) {
        return data(
          {
            intent,
            confirmCancel: false,
            error: "Платёжная система не вернула адрес для оплаты. Попробуйте позже.",
            errorCode: "no_redirect_url",
          },
          { status: 502 },
        );
      }
      throw redirect(payment.redirect_url);
    }

    return data(
      { intent, confirmCancel: false, error: "Неизвестное действие с заказом", errorCode: "unknown_intent" },
      { status: 400 },
    );
  } catch (cause) {
    // Редиректы бросаются внутри try, поэтому их нельзя ловить здесь общим
    // перехватчиком: `redirect()` возвращает Response, а не Error.
    if (cause instanceof Response) throw cause;
    return fail(describeApiError(cause, "Не удалось выполнить действие с заказом"));
  }
}

/* ──────────────────────────────── страница ───────────────────────────────── */

function StatusBadge({ order }: { order: OrderOut }) {
  return (
    <span className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-700">
      {orderStatusLabel(order.status, order.status_label)}
    </span>
  );
}

export default function OrderPage({ loaderData }: Route.ComponentProps) {
  // Ответ action'а приводим к общему типу: у интентов разные по смыслу поля,
  // но странице нужен один набор (ошибка и панель подтверждения).
  const actionData = useActionData<typeof action>() as OrderActionResult | undefined;
  const noticeKey = loaderData.notice ?? "";
  const notice = NOTICES[noticeKey];

  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader authenticated={loaderData.authenticated} />

      <main className="container-pulse flex-1 py-6 sm:py-10">
        {loaderData.state === "guest" ? (
          <GuestState />
        ) : loaderData.state === "missing" ? (
          <MissingState />
        ) : loaderData.state === "error" ? (
          <ErrorState error={loaderData.error} />
        ) : (
          <OrderView order={loaderData.order} placed={loaderData.placed} notice={notice} actionResult={actionData} />
        )}
      </main>
    </div>
  );
}

/** Гостевой заказ недоступен по ссылке — объясняем это, а не показываем 404. */
function GuestState() {
  return (
    <div className="card mx-auto max-w-2xl p-8 text-center">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">Заказ гостя</h1>
      <p className="mx-auto mt-3 max-w-md text-sm text-slate-600">
        Гостевой заказ не привязан к аккаунту, поэтому открыть его по ссылке нельзя. Сохраните номер
        заказа из подтверждения — по нему менеджер найдёт покупку. Зарегистрируйтесь, чтобы видеть
        историю заказов в кабинете.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <a href="/register" className="rounded-xl bg-pulse-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-pulse-700">
          Зарегистрироваться
        </a>
        <a href="/catalog" className="rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50">
          В каталог
        </a>
      </div>
    </div>
  );
}

function MissingState() {
  return (
    <div className="card mx-auto max-w-2xl p-8 text-center">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">Заказ не найден</h1>
      <p className="mx-auto mt-3 max-w-md text-sm text-slate-600">
        Такого заказа нет или он принадлежит другому покупателю. Проверьте ссылку — номер заказа
        выглядит как PL-20261007-7717.
      </p>
      <a href="/account" className="mt-6 inline-block rounded-xl bg-pulse-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-pulse-700">
        История заказов
      </a>
    </div>
  );
}

function ErrorState({ error }: { error: ApiErrorInfo }) {
  return (
    <div role="alert" className="card mx-auto max-w-2xl border-rose-200 bg-rose-50 p-8 text-center">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">
        {error.status > 0 ? `Ошибка ${error.status}` : "Нет связи с сервером"}
      </h1>
      <p className="mx-auto mt-3 max-w-md text-sm text-slate-700">{error.message}</p>
      <a href="/account" className="mt-6 inline-block rounded-xl bg-pulse-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-pulse-700">
        История заказов
      </a>
    </div>
  );
}

function OrderView({
  order,
  placed,
  notice,
  actionResult,
}: {
  order: OrderOut;
  placed: boolean;
  notice: string | undefined;
  actionResult: OrderActionResult | undefined;
}) {
  const canPay =
    order.payment_status !== "paid" &&
    (order.payment_method === "card" || order.payment_method === "online") &&
    PAYABLE_STATUSES.has(order.status);

  return (
    <>
      {placed ? (
        <div role="status" className="card border-emerald-200 bg-emerald-50 p-6 text-center sm:p-8">
          <p aria-hidden="true" className="text-4xl">
            ✅
          </p>
          <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-900">Спасибо за заказ!</h1>
          <p className="mt-2 text-sm text-slate-700">
            Заказ <strong className="font-semibold">{order.order_number}</strong> принят в обработку.
            Статус — {orderStatusLabel(order.status, order.status_label)}. Подтверждение придёт на{" "}
            {order.customer_email ?? "указанную почту"}.
          </p>
          <p className="mt-4 text-2xl font-bold text-slate-900">{formatPrice(order.total_amount)}</p>
          {canPay ? (
            <Form method="post" className="mt-6">
              <input type="hidden" name="intent" value="pay" />
              <button
                type="submit"
                className="rounded-xl bg-pulse-600 px-6 py-3 font-semibold text-white transition-colors hover:bg-pulse-700"
              >
                Оплатить {formatPrice(order.total_amount)}
              </button>
            </Form>
          ) : null}
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <a href="/account" className="rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50">
              В личный кабинет
            </a>
            <a href="/catalog" className="rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50">
              Продолжить покупки
            </a>
          </div>
        </div>
      ) : (
        <>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            Заказ {order.order_number}
          </h1>
          <p className="mt-1.5 text-sm text-slate-600">
            {new Date(order.created_at).toLocaleString("ru-RU")} · {deliveryMethodLabel(order.delivery_method)} ·{" "}
            {paymentMethodLabel(order.payment_method)}
          </p>
        </>
      )}

      {notice && !placed ? (
        <p role="status" className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-sm font-medium text-emerald-800">
          {notice}
        </p>
      ) : null}

      {actionResult?.error ? (
        <p role="alert" className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm font-medium text-rose-700">
          {actionResult.error}
        </p>
      ) : null}

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-6">
          <section className="card p-5 sm:p-6">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-slate-900">Состав заказа</h2>
              <StatusBadge order={order} />
            </div>

            <ul className="mt-4 space-y-2.5">
              {order.items.map((item) => (
                <li key={item.id} className="rounded-xl border border-slate-200 p-3.5">
                  <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900">{item.product_name}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {item.sku} · {item.quantity} {plural(item.quantity, "шт.", "шт.", "шт.")} ×{" "}
                        {formatPrice(item.price)}
                      </p>
                    </div>
                    <p className="text-sm font-semibold text-slate-900">{formatPrice(item.total_price)}</p>
                  </div>
                </li>
              ))}
            </ul>

            <dl className="mt-5 space-y-2 border-t border-slate-200 pt-4 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-slate-600">Товары</dt>
                <dd className="font-medium text-slate-900">{formatPrice(order.subtotal)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-600">
                  Скидка{order.promo_code ? ` по промокоду ${order.promo_code}` : ""}
                </dt>
                <dd className="font-medium text-emerald-700">−{formatPrice(order.discount_amount)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-600">Доставка</dt>
                <dd className="font-medium text-slate-900">
                  {order.delivery_cost === "0" ? "бесплатно" : formatPrice(order.delivery_cost)}
                </dd>
              </div>
              <div className="flex justify-between gap-3 border-t border-slate-200 pt-3 text-base">
                <dt className="font-semibold text-slate-900">Итого</dt>
                <dd className="font-bold text-slate-900">{formatPrice(order.total_amount)}</dd>
              </div>
            </dl>
          </section>

          <section className="card p-5 sm:p-6">
            <h2 className="text-lg font-semibold text-slate-900">Доставка и оплата</h2>
            <dl className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-sm text-slate-500">Способ доставки</dt>
                <dd className="mt-1 text-sm font-medium text-slate-900">
                  {deliveryMethodLabel(order.delivery_method)}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-slate-500">Адрес</dt>
                <dd className="mt-1 text-sm font-medium text-slate-900">
                  {addressLine(order.delivery_address) || "не требуется"}
                </dd>
                {order.delivery_address?.comment ? (
                  <dd className="mt-1 text-xs text-slate-500">{order.delivery_address.comment}</dd>
                ) : null}
              </div>
              <div>
                <dt className="text-sm text-slate-500">Способ оплаты</dt>
                <dd className="mt-1 text-sm font-medium text-slate-900">
                  {paymentMethodLabel(order.payment_method)}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-slate-500">Статус оплаты</dt>
                <dd className="mt-1 text-sm font-medium text-slate-900">
                  {paymentStatusLabel(order.payment_status)}
                </dd>
              </div>
              {order.tracking_number ? (
                <div>
                  <dt className="text-sm text-slate-500">Трек-номер</dt>
                  <dd className="mt-1 font-mono text-sm font-medium text-slate-900">{order.tracking_number}</dd>
                </div>
              ) : null}
              <div>
                <dt className="text-sm text-slate-500">Покупатель</dt>
                <dd className="mt-1 text-sm font-medium text-slate-900">
                  {order.customer_first_name} {order.customer_last_name}
                </dd>
                <dd className="mt-0.5 text-xs text-slate-500">
                  {order.customer_phone}
                  {order.customer_email ? ` · ${order.customer_email}` : ""}
                </dd>
              </div>
            </dl>

            {order.comment ? (
              <p className="mt-4 rounded-xl bg-slate-50 px-3.5 py-3 text-sm text-slate-700">
                <span className="font-medium">Комментарий:</span> {order.comment}
              </p>
            ) : null}
            {order.manager_comment ? (
              <p className="mt-3 rounded-xl border border-sky-200 bg-sky-50 px-3.5 py-3 text-sm text-sky-900">
                <span className="font-medium">Комментарий менеджера:</span> {order.manager_comment}
              </p>
            ) : null}
          </section>
        </div>

        <aside aria-label="Действия с заказом" className="lg:sticky lg:top-20 lg:self-start">
          <div className="card p-5">
            <h2 className="text-lg font-semibold text-slate-900">Действия</h2>

            {canPay ? (
              <Form method="post" className="mt-4">
                <input type="hidden" name="intent" value="pay" />
                <button
                  type="submit"
                  className="w-full rounded-xl bg-pulse-600 px-5 py-3 font-semibold text-white transition-colors hover:bg-pulse-700"
                >
                  Оплатить {formatPrice(order.total_amount)}
                </button>
              </Form>
            ) : (
              <p className="mt-4 text-sm text-slate-600">
                {order.payment_status === "paid"
                  ? "Заказ оплачен."
                  : "Оплата этого способом не требуется сейчас."}
              </p>
            )}

            <Form method="post" className="mt-3">
              <input type="hidden" name="intent" value="reorder" />
              <button
                type="submit"
                className="w-full rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition-colors hover:border-pulse-400 hover:text-pulse-700"
              >
                Повторить заказ
              </button>
              <p className="mt-1.5 text-xs text-slate-500">
                Позиции вернутся в корзину. Сколько товара есть на складе — решает сервер.
              </p>
            </Form>

            {order.can_cancel ? (
              <Form method="post" className="mt-3">
                <input type="hidden" name="intent" value="cancel_confirm" />
                <button
                  type="submit"
                  className="w-full rounded-xl border border-rose-300 bg-white px-5 py-3 text-sm font-semibold text-rose-600 transition-colors hover:bg-rose-50"
                >
                  Отменить заказ
                </button>

                {/*
                  Подтверждение — вторым шагом и отдельной кнопкой. Отмена
                  необратима (резерв снимается, статус меняется), поэтому
                  одного клика по «Отменить» недостаточно. Без JavaScript панель
                  появляется обычной перезагрузкой страницы.
                */}
                {actionResult?.confirmCancel ? (
                  <div
                    role="alert"
                    className="mt-3 rounded-xl border border-rose-300 bg-rose-50 p-3.5 text-sm text-rose-900"
                  >
                    <p className="font-semibold">Отменить заказ {order.order_number}?</p>
                    <p className="mt-1">
                      Действие необратимо: резерв товара снимется, а заказ перейдёт в статус «Отменён».
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="submit"
                        name="intent"
                        value="cancel"
                        className="rounded-lg bg-rose-600 px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-rose-700"
                      >
                        Да, отменить
                      </button>
                      <a
                        href={`/order/${order.id}`}
                        className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700"
                      >
                        Нет, вернуться
                      </a>
                    </div>
                  </div>
                ) : null}
              </Form>
            ) : (
              <p className="mt-3 text-xs text-slate-500">
                Отменить уже нельзя: заказ перешёл в сборку или уже отменён.
              </p>
            )}

            <a
              href="/account"
              className="mt-5 block text-center text-sm font-semibold text-pulse-600 hover:text-pulse-700"
            >
              Все заказы в кабинете
            </a>
          </div>
        </aside>
      </div>
    </>
  );
}