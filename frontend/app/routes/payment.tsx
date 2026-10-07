import type { Route } from "./+types/payment";

import { data, Form, redirect, useActionData } from "react-router";

import type { OrderOut, PaymentStartResponse } from "~/lib/order";
import { describeApiError } from "~/lib/api-error";
import { ApiError, serverFetch } from "~/lib/api.server";
import { clearAccessCookieHeader, readAccessToken } from "~/lib/auth-token";
import { orderStatusLabel } from "~/lib/order";
import { formatPrice } from "~/lib/format";
import { useAuthStore } from "~/stores/auth";
import { SiteHeader } from "~/widgets/site-header";

export function meta(): Route.MetaDescriptors {
  return [
    { title: "Оплата заказа — ПУЛЬС" },
    { name: "robots", content: "noindex" },
  ];
}

/**
 * Страница подтверждения оплаты `/payment/:orderId` (фейковый провайдер).
 *
 * Настоящая платёжная система уводит покупателя на свой домен и подтверждает
 * оплату вебхуком. Здесь провайдер фейковый, поэтому подтверждение делает сам
 * пользователь: `POST /payments/{orderId}/confirm` с токеном из ссылки.
 *
 * Токен приходит в query-параметре — его backend кладёт в `redirect_url`
 * (`/payment/{id}?token=…`, проверено живым запросом). Токен не хранится в
 * форме как секрет: он и так виден в адресной строке, а форма его переносит
 * в POST, чтобы кнопка «Оплатить» работала без JavaScript.
 */

/** Ответ action'а: успех уходит редиректом, здесь только ошибки. */
type PaymentActionResult = {
  error: string;
  errorCode: string;
  /** Токен не прошёл: имеет смысл выпустить новую ссылку. */
  canRestart: boolean;
};

export async function loader({ request, params }: Route.LoaderArgs) {
  const token = readAccessToken(request, useAuthStore.getState().accessToken);
  const orderId = params.orderId ?? "";
  const url = new URL(request.url);
  const paymentToken = url.searchParams.get("token") ?? "";

  if (!token) throw redirect("/login");

  const headers = { Authorization: `Bearer ${token}` };

  try {
    const order = await serverFetch<OrderOut>(`/orders/${encodeURIComponent(orderId)}`, { headers });
    return {
      authenticated: true,
      order,
      paymentToken,
      /** Ссылка без токена: объясняем, что делать дальше, а не просто 400. */
      hasToken: paymentToken.length > 0,
    };
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401) {
      throw redirect("/login", { headers: { "Set-Cookie": clearAccessCookieHeader() } });
    }
    const error = describeApiError(cause, "Не удалось загрузить заказ");
    return { authenticated: true, order: null, paymentToken, hasToken: false, error };
  }
}

export async function action({ request, params }: Route.ActionArgs) {
  const token = readAccessToken(request, useAuthStore.getState().accessToken);
  if (!token) throw redirect("/login");

  const orderId = params.orderId ?? "";
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "confirm");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  function fail(message: string, code: string, status: number, canRestart = false) {
    return data<PaymentActionResult>({ error: message, errorCode: code, canRestart }, { status });
  }

  // Токен берём из формы (её отправляет кнопка), а не из адресной строки:
  // так подтверждение одинаково работает и с JS, и без него.
  const confirmationToken = String(form.get("token") ?? "").trim();

  if (intent === "start") {
    // Токен в ссылке не пришёл или протух — выпускаем новый платёж и
    // отправляем покупателя по свежему адресу провайдера.
    try {
      const payment = await serverFetch<PaymentStartResponse>(
        `/orders/${encodeURIComponent(orderId)}/payment`,
        { method: "POST", headers },
      );
      if (!payment.redirect_url) {
        return fail("Платёжная система не вернула адрес оплаты", "no_redirect_url", 502, true);
      }
      throw redirect(payment.redirect_url);
    } catch (cause) {
      if (cause instanceof Response) throw cause;
      const info = describeApiError(cause, "Не удалось начать оплату");
      // `already_paid` — не ошибка оформления: заказ уже оплачен.
      if (info.code === "already_paid") {
        return fail("Заказ уже оплачен — возвращаться к оплате не нужно.", info.code, info.status || 400, true);
      }
      return fail(info.message, info.code, info.status > 0 && info.status < 500 ? info.status : 400, true);
    }
  }

  if (!confirmationToken) {
    return fail(
      "В ссылке нет токена оплаты. Начните оплату заново — мы выдадим новую ссылку.",
      "missing_token",
      400,
      true,
    );
  }

  try {
    await serverFetch<{ message: string }>(`/payments/${encodeURIComponent(orderId)}/confirm`, {
      method: "POST",
      headers,
      body: JSON.stringify({ token: confirmationToken }),
    });
  } catch (cause) {
    const info = describeApiError(cause, "Не удалось подтвердить оплату");
    const status = info.status > 0 && info.status < 500 ? info.status : 400;

    if (info.code === "already_paid") {
      throw redirect(`/order/${orderId}?notice=paid`);
    }

    /*
      Неверный токен приходит двумя способами (проверено живыми запросами):
      `invalid_payment_token` (400) — токен есть, но не подошёл; и
      `validation_error` с `fields.token` (422) — токен обрезан или подставлен.
      Для покупателя это одно и то же, поэтому текст и подсказка одинаковые.
    */
    const tokenRejected = info.code === "invalid_payment_token" || Boolean(info.fields.token);
    if (tokenRejected) {
      return fail(
        "Ссылка на оплату недействительна или истекла. Выпустите новую ссылку — оплата ещё доступна.",
        info.code === "invalid_payment_token" ? info.code : "invalid_payment_token",
        status,
        true,
      );
    }

    return fail(info.message, info.code, status);
  }

  throw redirect(`/order/${orderId}?notice=paid`);
}

export default function PaymentPage({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();

  if (!loaderData.order) {
    return (
      <Frame authenticated={loaderData.authenticated}>
        <div role="alert" className="card border-rose-200 bg-rose-50 p-8 text-center">
          <h1 className="text-xl font-bold text-slate-900">Заказ не найден</h1>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-700">
            {"error" in loaderData && loaderData.error
              ? loaderData.error.message
              : "Проверьте ссылку на оплату: возможно, она устарела."}
          </p>
          <a
            href="/account"
            className="mt-6 inline-block rounded-xl bg-pulse-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-pulse-700"
          >
            Мои заказы
          </a>
        </div>
      </Frame>
    );
  }

  const order = loaderData.order;
  const paid = order.payment_status === "paid";

  return (
    <Frame authenticated={loaderData.authenticated}>
      <div className="mx-auto max-w-xl">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">Оплата заказа</h1>
        <p className="mt-1.5 text-sm text-slate-600">
          Заказ {order.order_number} · {orderStatusLabel(order.status, order.status_label)}
        </p>

        {actionData ? (
          <div
            role="alert"
            className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm font-medium text-rose-700"
          >
            <p>{actionData.error}</p>
            {actionData.canRestart ? (
              <Form method="post" className="mt-3">
                <input type="hidden" name="intent" value="start" />
                <button
                  type="submit"
                  className="rounded-xl border border-rose-300 bg-white px-4 py-2 text-sm font-semibold text-rose-700 transition-colors hover:bg-rose-100"
                >
                  Выпустить новую ссылку
                </button>
              </Form>
            ) : null}
          </div>
        ) : null}

        <div className="card mt-6 p-6 text-center">
          <p className="text-sm text-slate-600">К оплате</p>
          <p className="mt-1 text-3xl font-bold text-slate-900">{formatPrice(order.total_amount)}</p>

          {paid ? (
            <>
              <p role="status" className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-sm font-medium text-emerald-800">
                Заказ уже оплачен — подтверждать ничего не нужно.
              </p>
              <a
                href={`/order/${order.id}`}
                className="mt-5 inline-block rounded-xl bg-pulse-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-pulse-700"
              >
                Открыть заказ
              </a>
            </>
          ) : loaderData.hasToken ? (
            <>
              <p className="mt-3 text-sm text-slate-600">
                Это демонстрационный платёжный провайдер: деньги списываться не будут, нажатие
                подтверждает оплату и переводит заказ в статус «Оплачен».
              </p>
              <Form method="post" className="mt-5">
                <input type="hidden" name="intent" value="confirm" />
                <input type="hidden" name="token" value={loaderData.paymentToken} />
                <button
                  type="submit"
                  className="w-full rounded-xl bg-pulse-600 px-5 py-3 text-base font-semibold text-white transition-colors hover:bg-pulse-700"
                >
                  Оплатить {formatPrice(order.total_amount)}
                </button>
              </Form>
              <p className="mt-3 text-xs text-slate-500">
                <a href={`/order/${order.id}`} className="font-semibold text-pulse-600 hover:text-pulse-700">
                  Вернуться к заказу
                </a>{" "}
                и оплатить позже.
              </p>
            </>
          ) : (
            <>
              <p className="mt-3 text-sm text-slate-600">
                В ссылке нет токена оплаты. Выпустим новый — оплата ещё доступна.
              </p>
              <Form method="post" className="mt-5">
                <input type="hidden" name="intent" value="start" />
                <button
                  type="submit"
                  className="w-full rounded-xl bg-pulse-600 px-5 py-3 text-base font-semibold text-white transition-colors hover:bg-pulse-700"
                >
                  Перейти к оплате
                </button>
              </Form>
            </>
          )}
        </div>

        <p className="mt-4 text-center text-xs text-slate-500">
          Платёжные данные магазин не хранит: подтверждает платёж сам провайдер.
        </p>
      </div>
    </Frame>
  );
}

function Frame({ authenticated, children }: { authenticated: boolean; children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader authenticated={authenticated} />
      <main className="container-pulse flex-1 py-6 sm:py-10">{children}</main>
    </div>
  );
}