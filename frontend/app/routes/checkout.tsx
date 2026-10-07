import type { Route } from "./+types/checkout";

import { data, Form, redirect, useActionData } from "react-router";

import type { ApiErrorInfo } from "~/lib/api-error";
import type { Cart } from "~/lib/cart";
import type {
  CheckoutPreview,
  DeliveryMethod,
  OrderCreatePayload,
  OrderOut,
  PaymentMethod,
} from "~/lib/order";
import { describeApiError } from "~/lib/api-error";
import { serverFetch } from "~/lib/api.server";
import type { UserOut } from "~/lib/auth";
import { cartRequestHeaders } from "~/lib/cart";
import { readAccessToken } from "~/lib/auth-token";
import { DELIVERY_OPTIONS, PAYMENT_OPTIONS, isDeliveryMethod, isPaymentMethod, needsDeliveryAddress } from "~/lib/order";
import { formatPrice, plural } from "~/lib/format";
import { useAuthStore } from "~/stores/auth";
import { FormField } from "~/widgets/form-field";
import { SiteHeader } from "~/widgets/site-header";

export function meta(): Route.MetaDescriptors {
  return [
    { title: "Оформление заказа — ПУЛЬС" },
    { name: "description", content: "Оформление заказа: доставка, оплата и подтверждение." },
    // Страница зависит от содержимого корзины конкретного человека: в индекс её
    // не нужно, а вот ссылку можно переслать.
    { name: "robots", content: "noindex" },
  ];
}

/**
 * Оформление заказа `/checkout` — семь шагов раздела 5.9 ТЗ на одной странице.
 *
 * Почему одна страница, а не «назад-вперёд»: искусственная многошаговость
 * теряет данные при любой ошибке (покупатель возвращается на шаг назад и
 * начинает заново) и снижает конверсию. Здесь все шаги видны сразу, а порядок
 * — это порядок чтения, а не порядок переходов.
 *
 * Три правила, из которых следует остальной код:
 *  1. Итог считает сервер (`POST /checkout/preview`). В браузере нет ни одного
 *     арифметического действия с деньгами: цены на клиенте меняются чаще,
 *     чем на бэке, и покупатель увидел бы одну сумму, а оплатил другую.
 *  2. Форма — одна и обычная (`<Form method="post">`), поэтому работает без
 *     JavaScript: переключатели, промокод и кнопка оформления отправляются
 *     тем же action'ом, что и при полной перезагрузке.
 *  3. Значения полей возвращаются в `values` ответа action'а и становятся
 *     `defaultValue`. Без этого после отправки «без JS» форма очистилась бы,
 *     а пользователю пришлось бы вводить всё заново.
 */

/** Значения формы одинаковы в loader'е и action'е — отсюда один тип. */
type CheckoutValues = {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  delivery_method: DeliveryMethod;
  payment_method: PaymentMethod;
  city: string;
  street: string;
  building: string;
  apartment: string;
  postal_code: string;
  address_comment: string;
  promo_code: string;
  comment: string;
  /**
   * Ключ идемпотентности. Родится в loader'е вместе с формой и переживает
   * неудачную отправку (возвращается в `values`), поэтому повторная попытка
   * после сбоя сети не создаёт второй заказ — backend вернёт тот же.
   */
  idempotency_key: string;
};

/** Единый ответ action'а: и пересчёт, и неудачное оформление. */
type CheckoutActionResult = {
  intent: string;
  values: CheckoutValues;
  preview: CheckoutPreview | null;
  error: string | null;
  errorCode: string | null;
  fields: Record<string, string>;
};

/* ───────────────────────────── значения формы ───────────────────────────── */

function readFormString(form: FormData, name: string): string {
  return String(form.get(name) ?? "").trim();
}

/** Новый ключ идемпотентности на каждую попытку оформления. */
function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * Перечисления из формы сужаем guard'ами, а не приводим типом.
 *
 * Без этого `delivery_method: "hash"` ушёл бы в тело запроса и вернул 422 без
 * указания, что именно не так.
 */
function parseValues(form: FormData): CheckoutValues {
  const rawDelivery = readFormString(form, "delivery_method");
  const rawPayment = readFormString(form, "payment_method");

  return {
    first_name: readFormString(form, "customer_first_name"),
    last_name: readFormString(form, "customer_last_name"),
    email: readFormString(form, "customer_email"),
    phone: readFormString(form, "customer_phone"),
    delivery_method: isDeliveryMethod(rawDelivery) ? rawDelivery : "courier",
    payment_method: isPaymentMethod(rawPayment) ? rawPayment : "card",
    city: readFormString(form, "city"),
    street: readFormString(form, "street"),
    building: readFormString(form, "building"),
    apartment: readFormString(form, "apartment"),
    postal_code: readFormString(form, "postal_code"),
    address_comment: readFormString(form, "address_comment"),
    promo_code: readFormString(form, "promo_code"),
    comment: readFormString(form, "comment"),
    idempotency_key: readFormString(form, "idempotency_key") || newIdempotencyKey(),
  };
}

/** Значения по умолчанию: профиль покупателя, если он вошёл. */
function defaultValues(profile: UserOut | null, idempotency_key: string): CheckoutValues {
  return {
    first_name: profile?.first_name ?? "",
    last_name: profile?.last_name ?? "",
    email: profile?.email ?? "",
    phone: profile?.phone ?? "",
    delivery_method: "courier",
    payment_method: "card",
    city: "",
    street: "",
    building: "",
    apartment: "",
    postal_code: "",
    address_comment: "",
    promo_code: "",
    comment: "",
    idempotency_key,
  };
}

/**
 * Тело `POST /orders`.
 *
 * Цен здесь нет и не должно быть: раздел 22 ТЗ требует, чтобы сумму считал
 * сервер. Клиент отвечает только за состав корзины (она уже в cookie) и за
 * данные покупателя.
 */
function buildPayload(values: CheckoutValues): OrderCreatePayload {
  const addressRequired = needsDeliveryAddress(values.delivery_method);

  return {
    customer_first_name: values.first_name,
    customer_last_name: values.last_name,
    customer_email: values.email,
    customer_phone: values.phone,
    delivery_method: values.delivery_method,
    payment_method: values.payment_method,
    delivery_address: addressRequired
      ? {
          city: values.city,
          street: values.street,
          building: values.building,
          apartment: values.apartment || null,
          postal_code: values.postal_code || null,
          comment: values.address_comment || null,
        }
      : null,
    // Пункты выдачи backend пока не отдаёт (см. раздел «Пункт выдачи» в UI),
    // поэтому идентификатор пустой, а конкретный пункт подтверждает менеджер.
    pickup_point_id: null,
    comment: values.comment || null,
    promo_code: values.promo_code || null,
  };
}

/* ──────────────────────────── расчёт на сервере ─────────────────────────── */

type PreviewResult = { preview: CheckoutPreview; error: null } | { preview: null; error: ApiErrorInfo };

/**
 * Предварительный расчёт: `POST /checkout/preview`.
 *
 * Ошибку не бросаем, а возвращаем: неверный промокод (400 `promo_not_found`)
 * или пустая корзина — это не поломка страницы, а сообщение рядом с полем.
 */
async function fetchPreview(
  delivery_method: DeliveryMethod,
  payment_method: PaymentMethod,
  promo_code: string,
  headers: Record<string, string>,
): Promise<PreviewResult> {
  try {
    const preview = await serverFetch<CheckoutPreview>("/checkout/preview", {
      method: "POST",
      headers,
      body: JSON.stringify({
        delivery_method,
        payment_method,
        ...(promo_code ? { promo_code } : {}),
      }),
    });
    return { preview, error: null };
  } catch (cause) {
    return { preview: null, error: describeApiError(cause, "Не удалось рассчитать заказ") };
  }
}

/* ────────────────────────────────── loader ───────────────────────────────── */

export async function loader({ request }: Route.LoaderArgs) {
  const token = readAccessToken(request, useAuthStore.getState().accessToken);
  const headers = cartRequestHeaders(request, token);
  const jsonHeaders = { ...headers, "Content-Type": "application/json" };

  // Шаг 1: состав корзины. Без неё оформлять нечего, но сама страница
  // показывается — чтобы объяснить это и дать ссылку в каталог.
  let cart: Cart | null = null;
  let cartError: ApiErrorInfo | null = null;
  try {
    cart = await serverFetch<Cart>("/cart", { headers });
  } catch (cause) {
    cartError = describeApiError(cause, "Не удалось загрузить корзину");
  }

  // Профиль только для предзаполнения: его отсутствие не должно мешать
  // оформлению гостя, поэтому 401/ошибку молча пропускаем.
  const profile = token
    ? await serverFetch<UserOut>("/auth/me", { headers }).catch(() => null)
    : null;

  const hasItems = Boolean(cart && cart.items.length > 0);
  const { preview, error: previewError } = hasItems
    ? await fetchPreview("courier", "card", "", jsonHeaders)
    : { preview: null, error: null };

  return {
    authenticated: Boolean(token),
    cart,
    cartError,
    profile,
    preview,
    previewError,
    values: defaultValues(profile, newIdempotencyKey()),
  };
}

/* ────────────────────────────────── action ───────────────────────────────── */

/**
 * Имена полей API → имена полей формы.
 *
 * Backend присылает `fields` ключами своей схемы (`customer_first_name`),
 * а подсветить надо конкретный `<input>` формы. Неизвестный ключ оставляем как
 * есть: вдруг backend начнёт присылать новое поле — оно попадёт в общий блок.
 */
const FIELD_ALIASES: Record<string, string> = {
  customer_first_name: "first_name",
  customer_last_name: "last_name",
  customer_email: "email",
  customer_phone: "phone",
  "delivery_address.city": "city",
  "delivery_address.street": "street",
  "delivery_address.building": "building",
  "delivery_address.apartment": "apartment",
  "delivery_address.postal_code": "postal_code",
  promo_code: "promo_code",
  comment: "comment",
};

function remapFields(fields: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, message] of Object.entries(fields)) {
    // `_root` — ошибка всего запроса (например, «Для доставки курьером нужен
    // адрес»): её нельзя повесить на поле, она идёт в общий блок ошибки.
    if (key === "_root" || !message) continue;
    result[FIELD_ALIASES[key] ?? key] = message;
  }
  return result;
}

/**
 * Проверка на сервере роутера — до похода в API.
 *
 * Только то, что backend всё равно отвергнет, но вернёт не под то поле
 * (у него это `fields._root`), из-за чего подсветить поле не получилось бы.
 */
function validateLocally(values: CheckoutValues): Record<string, string> {
  const fields: Record<string, string> = {};

  if (values.first_name.length < 2) fields.first_name = "Укажите имя (минимум 2 символа)";
  if (values.last_name.length < 2) fields.last_name = "Укажите фамилию (минимум 2 символа)";
  if (!values.email.includes("@")) fields.email = "Укажите e-mail — на него придёт подтверждение";
  if (values.phone.length < 6) fields.phone = "Укажите телефон для связи по заказу";

  if (needsDeliveryAddress(values.delivery_method)) {
    if (values.city.length < 2) fields.city = "Укажите город";
    if (values.street.length < 2) fields.street = "Укажите улицу";
    if (!values.building) fields.building = "Укажите дом";
  }

  return fields;
}

/**
 * Текст ошибки оформления.
 *
 * Для кодов, где backend уже написал точное объяснение (`insufficient_stock`,
 * `promo_not_found`), берём его дословно; свои формулировки оставляем для
 * технических состояний, которые покупатель не вызывал.
 */
function orderErrorMessage(info: ApiErrorInfo): string {
  switch (info.code) {
    case "insufficient_stock":
    case "promo_not_found":
    case "account_blocked":
      return info.message;
    case "empty_cart":
      return "Корзина уже пуста — оформлять нечего. Возможно, заказ только что создан.";
    case "rate_limited":
      return "Слишком много попыток оформления. Подождите минуту и повторите.";
    case "network_error":
      return "Сервер недоступен. Нажмите «Оформить заказ» ещё раз — повтор безопасен, ключ запроса тот же.";
    case "validation_error":
      return info.message;
    default:
      return info.status >= 500
        ? "Не удалось оформить заказ: сервер временно недоступен. Повторите попытку через минуту."
        : info.message;
  }
}

export async function action({ request }: Route.ActionArgs) {
  const token = readAccessToken(request, useAuthStore.getState().accessToken);
  const headers = { ...cartRequestHeaders(request, token), "Content-Type": "application/json" };

  const form = await request.formData();
  const values = parseValues(form);
  // Кнопки формы несут значение `intent`; Enter в текстовом поле отправляет
  // первую кнопку (пересчёт) — безопасный вариант, он ничего не меняет.
  const intent = readFormString(form, "intent") || "preview";

  if (intent === "preview") {
    const { preview, error } = await fetchPreview(
      values.delivery_method,
      values.payment_method,
      values.promo_code,
      headers,
    );
    const result: CheckoutActionResult = {
      intent,
      values,
      preview,
      error: error?.message ?? null,
      errorCode: error?.code ?? null,
      fields: error ? remapFields(error.fields) : {},
    };
    return data(result, { status: 200 });
  }

  if (intent !== "create") {
    const result: CheckoutActionResult = {
      intent,
      values,
      preview: null,
      error: "Неизвестное действие",
      errorCode: "unknown_intent",
      fields: {},
    };
    return data(result, { status: 400 });
  }

  const localFields = validateLocally(values);
  if (Object.keys(localFields).length > 0) {
    const result: CheckoutActionResult = {
      intent,
      values,
      preview: null,
      error: "Проверьте выделенные поля",
      errorCode: "validation_error",
      fields: localFields,
    };
    return data(result, { status: 400 });
  }

  let order: OrderOut | null = null;
  let failure: ApiErrorInfo | null = null;
  try {
    order = await serverFetch<OrderOut>("/orders", {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": values.idempotency_key },
      body: JSON.stringify(buildPayload(values)),
    });
  } catch (cause) {
    failure = describeApiError(cause, "Не удалось оформить заказ");
  }

  // Редирект вне try: `redirect()` бросает объект Response, и перехватчик
  // ошибок проглотил бы его, показав вместо редиректа текст о неудаче.
  if (order) throw redirect(`/order/${order.id}?placed=1`);

  const info = failure ?? { status: 0, code: "unknown_error", message: "Не удалось оформить заказ", fields: {} };

  // Пересчитываем итог с теми же значениями, что в форме: после отказа
  // показывать сумму, посчитанную для других способов доставки, нечестно.
  const { preview } = await fetchPreview(
    values.delivery_method,
    values.payment_method,
    values.promo_code,
    headers,
  );

  const result: CheckoutActionResult = {
    intent,
    values,
    preview,
    error: orderErrorMessage(info),
    errorCode: info.code,
    fields: remapFields(info.fields),
  };
  return data(result, { status: info.status > 0 && info.status < 500 ? info.status : 400 });
}

/* ──────────────────────────────── блоки UI ──────────────────────────────── */

/** Заголовок шага раздела 5.9. */
function StepHeading({ step, title, children }: { step: number; title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h2 className="text-base font-semibold text-slate-900">
        <span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-pulse-100 text-xs font-bold text-pulse-800">
          {step}
        </span>
        {title}
      </h2>
      {children ? <p className="mt-1 text-sm text-slate-600">{children}</p> : null}
    </div>
  );
}

/** Переключатель с подписью: label связан с input через htmlFor + id. */
function OptionRow({
  id,
  name,
  value,
  checked,
  label,
  hint,
}: {
  id: string;
  name: string;
  value: string;
  checked: boolean;
  label: string;
  hint: string;
}) {
  return (
    <label
      htmlFor={id}
      className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-300 bg-white p-3 transition-colors hover:border-pulse-400 has-checked:border-pulse-600 has-checked:bg-pulse-50 sm:p-3.5"
    >
      <input
        id={id}
        type="radio"
        name={name}
        value={value}
        defaultChecked={checked}
        className="mt-0.5 h-4 w-4 shrink-0 border-slate-300 text-pulse-600"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-slate-900">{label}</span>
        <span className="mt-0.5 block text-xs text-slate-500">{hint}</span>
      </span>
    </label>
  );
}

/** Список позиций: он же состав заказа в предпросмотре. */
function ItemsList({
  items,
  caption,
}: {
  items: { id: string; product_name: string; sku: string; quantity: number; total_price: string }[];
  caption: string;
}) {
  return (
    <section aria-label={caption}>
      <ul className="space-y-2.5">
        {items.map((item) => (
          <li key={item.id} className="rounded-xl border border-slate-200 p-3.5">
            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900">{item.product_name}</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {item.sku} · {item.quantity} {plural(item.quantity, "шт.", "шт.", "шт.")}
                </p>
              </div>
              <p className="text-sm font-semibold text-slate-900">{formatPrice(item.total_price)}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Разбивка итога: товары, скидка, доставка, итого. */
function Totals({
  preview,
  promoCode,
}: {
  preview: CheckoutPreview;
  promoCode: string;
}) {
  return (
    <dl className="mt-4 space-y-2 text-sm">
      <div className="flex justify-between gap-3">
        <dt className="text-slate-600">
          Товаров: {preview.items_count} {plural(preview.items_count, "шт.", "шт.", "шт.")}
        </dt>
        <dd className="font-medium text-slate-900">{formatPrice(preview.subtotal)}</dd>
      </div>
      <div className="flex justify-between gap-3">
        <dt className="text-slate-600">Скидка{promoCode ? ` по промокоду ${promoCode}` : ""}</dt>
        <dd className="font-medium text-emerald-700">−{formatPrice(preview.discount_amount)}</dd>
      </div>
      <div className="flex justify-between gap-3">
        <dt className="text-slate-600">Доставка</dt>
        <dd className="font-medium text-slate-900">
          {preview.delivery_cost === "0" ? "бесплатно" : formatPrice(preview.delivery_cost)}
        </dd>
      </div>
      <div className="flex justify-between gap-3 border-t border-slate-200 pt-3 text-base">
        <dt className="font-semibold text-slate-900">К оплате</dt>
        <dd className="font-bold text-slate-900">{formatPrice(preview.total)}</dd>
      </div>
    </dl>
  );
}

/* ──────────────────────────────── страница ───────────────────────────────── */

export default function CheckoutPage({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();

  // Ответ action'а приоритетнее loader'а: после пересчёта или отказа в
  // оформлении итог должен соответствовать значениям, которые сейчас в форме.
  const values = actionData?.values ?? loaderData.values;
  const preview = actionData ? actionData.preview : loaderData.preview;
  const fields = actionData?.fields ?? {};
  const error = actionData?.error ?? null;
  // Причина, по которой итога нет, должна быть видна сразу: иначе кнопка
  // «Сначала пересчитайте» выглядит как зависшая страница.
  const previewError = actionData ? null : loaderData.previewError;

  const cart = loaderData.cart;
  const items = cart?.items ?? [];

  if (loaderData.cartError && !cart) {
    return (
      <Frame authenticated={loaderData.authenticated}>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">Оформление заказа</h1>
        <div role="alert" className="card mt-6 border-rose-200 bg-rose-50 p-6 text-center">
          <p className="text-sm font-semibold text-rose-700">
            {loaderData.cartError.status > 0 ? `Ошибка ${loaderData.cartError.status}` : "Нет связи с сервером"}
          </p>
          <p className="mt-2 text-sm text-slate-700">{loaderData.cartError.message}</p>
          <a href="/cart" className="mt-5 inline-block rounded-xl bg-pulse-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-pulse-700">
            Вернуться в корзину
          </a>
        </div>
      </Frame>
    );
  }

  if (items.length === 0) {
    return (
      <Frame authenticated={loaderData.authenticated}>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">Оформление заказа</h1>
        <div className="card mt-6 p-8 text-center sm:p-12">
          <p aria-hidden="true" className="text-4xl">
            🧾
          </p>
          <h2 className="mt-4 text-lg font-semibold text-slate-900">Оформлять нечего</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">
            В корзине нет товаров. Добавьте комплектующие в каталоге — и оформление станет доступно.
          </p>
          <a href="/catalog" className="mt-6 inline-block rounded-xl bg-pulse-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-pulse-700">
            Перейти в каталог
          </a>
        </div>
      </Frame>
    );
  }

  // Шаг 1 раздела 5.9: оформление блокируется, пока товара не хватает.
  //
  // Источников два, и это не избыточность, а страховка: `unavailable` из
  // предпросмотра — официальный сигнал backend-а, а `exceeds_stock` корзины
  // доступен всегда, даже если предпросмотр не удался. Сейчас
  // `POST /checkout/preview` падает с 500 (AttributeError на позиции корзины,
  // если хотя бы одна позиция превышает остаток), и без второго источника
  // блокировка просто исчезла бы.
  const unavailable = preview?.unavailable.length ? preview.unavailable : cartUnavailable(items);
  const blocked = unavailable.length > 0;
  const addressRequired = needsDeliveryAddress(values.delivery_method);

  return (
    <Frame authenticated={loaderData.authenticated}>
      <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">Оформление заказа</h1>
      <p className="mt-1.5 text-sm text-slate-600">
        Семь шагов на одной странице: заполните поля — итог посчитает сервер.
      </p>

      {error ? (
        <p role="alert" className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm font-medium text-rose-700">
          {error}
        </p>
      ) : null}

      {blocked ? (
        <div role="alert" className="mt-5 rounded-card border border-rose-300 bg-rose-50 p-4 sm:p-5">
          <p className="flex items-center gap-2 font-semibold text-rose-900">
            <span aria-hidden="true">⚠</span>
            Товара не хватает — оформление приостановлено
          </p>
          <ul className="mt-2.5 space-y-1.5 text-sm text-rose-900">
            {unavailable.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-rose-900">
            Уменьшите количество до доступного в{" "}
            <a href="/cart" className="font-semibold underline">
              корзине
            </a>{" "}
            и вернитесь сюда — оформление сразу станет доступно.
          </p>
        </div>
      ) : null}

      <Form method="post" className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_21rem]">
        {/* Ключ идемпотентности едет вместе с формой: повторная отправка после
            сбоя сети вернёт backend-у тот же ключ и тот же заказ. */}
        <input type="hidden" name="idempotency_key" value={values.idempotency_key} />

        <div className="space-y-6">
          {/* Шаг 1 */}
          <section className="card p-5 sm:p-6">
            <StepHeading step={1} title="Проверяем состав корзины">
              Все позиции и итог считает сервер — в форме цен нет.
            </StepHeading>
            {/*
              Состав берём из предпросмотра, когда он есть: там позиции уже с
              итоговыми суммами. Если расчёта нет (пустая корзина или сбой
              backend-а), показываем саму корзину — она тоже на сервере.
            */}
            <ItemsList
              caption="Состав корзины"
              items={preview && preview.items.length > 0 ? preview.items : items.map(toCartItemPreview)}
            />
            <a href="/cart" className="mt-4 inline-block text-sm font-semibold text-pulse-600 hover:text-pulse-700">
              Изменить состав в корзине
            </a>
          </section>

          {/* Шаг 2 */}
          <section className="card p-5 sm:p-6">
            <StepHeading step={2} title="Контактные данные">
              На e-mail придёт подтверждение, на телефон позвонит менеджер.
            </StepHeading>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                id="customer_first_name"
                label="Имя"
                name="customer_first_name"
                defaultValue={values.first_name}
                autoComplete="given-name"
                maxLength={100}
                required
                error={fields.first_name}
              />
              <FormField
                id="customer_last_name"
                label="Фамилия"
                name="customer_last_name"
                defaultValue={values.last_name}
                autoComplete="family-name"
                maxLength={100}
                required
                error={fields.last_name}
              />
              <FormField
                id="customer_email"
                label="E-mail"
                type="email"
                inputMode="email"
                name="customer_email"
                defaultValue={values.email}
                autoComplete="email"
                required
                error={fields.email}
              />
              <FormField
                id="customer_phone"
                label="Телефон"
                type="tel"
                inputMode="tel"
                name="customer_phone"
                defaultValue={values.phone}
                autoComplete="tel"
                placeholder="+7 900 000-00-00"
                required
                error={fields.phone}
              />
            </div>
          </section>

          {/* Шаг 3 */}
          <section className="card p-5 sm:p-6">
            <StepHeading step={3} title="Способ доставки">
              Стоимость доставки подставляется в итог сразу.
            </StepHeading>
            <fieldset>
              <legend className="sr-only">Способ доставки</legend>
              <div className="grid gap-2.5 sm:grid-cols-2">
                {DELIVERY_OPTIONS.map((option) => (
                  <OptionRow
                    key={option.value}
                    id={`delivery-${option.value}`}
                    name="delivery_method"
                    value={option.value}
                    checked={values.delivery_method === option.value}
                    label={option.label}
                    hint={option.hint}
                  />
                ))}
              </div>
            </fieldset>
          </section>

          {/* Шаг 4 */}
          <section className="card p-5 sm:p-6">
            <StepHeading step={4} title="Адрес или пункт выдачи">
              {addressRequired
                ? "Для курьера и транспортной компании адрес обязателен."
                : "Адрес не нужен: заберите заказ лично."}
            </StepHeading>

            {values.delivery_method === "pickup_point" ? (
              <p className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-3 text-sm text-amber-900">
                Справочника пунктов выдачи магазин пока не отдаёт, поэтому конкретный пункт выберет
                менеджер и подтвердит его по телефону. Стоимость доставки при этом 0 ₽.
              </p>
            ) : null}

            {values.delivery_method === "pickup" ? (
              <p className="rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3 text-sm text-slate-700">
                Адрес заполнять не нужно. Мы сообщим адрес магазина и время выдачи в подтверждении заказа.
              </p>
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    id="city"
                    label="Город"
                    name="city"
                    defaultValue={values.city}
                    autoComplete="address-level2"
                    maxLength={100}
                    placeholder="Красноярск"
                    error={fields.city}
                  />
                  <FormField
                    id="street"
                    label="Улица"
                    name="street"
                    defaultValue={values.street}
                    autoComplete="address-line1"
                    maxLength={255}
                    placeholder="Ленина"
                    error={fields.street}
                  />
                  <FormField
                    id="building"
                    label="Дом"
                    name="building"
                    defaultValue={values.building}
                    autoComplete="address-line2"
                    maxLength={20}
                    placeholder="18"
                    error={fields.building}
                  />
                  <FormField
                    id="apartment"
                    label="Квартира"
                    name="apartment"
                    defaultValue={values.apartment}
                    maxLength={20}
                    error={fields.apartment}
                  />
                  <FormField
                    id="postal_code"
                    label="Индекс"
                    name="postal_code"
                    defaultValue={values.postal_code}
                    inputMode="numeric"
                    autoComplete="postal-code"
                    maxLength={16}
                    error={fields.postal_code}
                  />
                  <FormField
                    id="address_comment"
                    label="Комментарий к адресу"
                    name="address_comment"
                    defaultValue={values.address_comment}
                    maxLength={255}
                    placeholder="Домофон, «позвонить за час»"
                    error={fields.address_comment}
                  />
                </div>
                <p className="mt-3 text-xs text-slate-500">
                  {addressRequired
                    ? "Поля обязательны: backend отвергнет заказ без адреса (проверено: 422)."
                    : "Заполните, если хотите, чтобы мы всё равно знали адрес. Для этого способа он не требуется."}
                </p>
              </>
            )}
          </section>

          {/* Шаг 5 */}
          <section className="card p-5 sm:p-6">
            <StepHeading step={5} title="Способ оплаты">
              Способы, требующие оплаты сразу, продолжатся на странице оплаты.
            </StepHeading>
            <fieldset>
              <legend className="sr-only">Способ оплаты</legend>
              <div className="grid gap-2.5 sm:grid-cols-2">
                {PAYMENT_OPTIONS.map((option) => (
                  <OptionRow
                    key={option.value}
                    id={`payment-${option.value}`}
                    name="payment_method"
                    value={option.value}
                    checked={values.payment_method === option.value}
                    label={option.label}
                    hint={option.hint}
                  />
                ))}
              </div>
            </fieldset>
          </section>

          {/* Шаг 6 */}
          <section className="card p-5 sm:p-6">
            <StepHeading step={6} title="Промокод">
              Нажмите «Пересчитать» — сервер проверит код и пересоберёт итог.
            </StepHeading>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-0 flex-1">
                <FormField
                  id="promo_code"
                  label="Промокод"
                  name="promo_code"
                  defaultValue={values.promo_code}
                  maxLength={50}
                  autoCapitalize="characters"
                  placeholder="SUMMER"
                  error={fields.promo_code}
                />
              </div>
              <button
                type="submit"
                name="intent"
                value="preview"
                className="mb-0.5 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:border-pulse-400 hover:text-pulse-700"
              >
                Пересчитать
              </button>
            </div>

            {/*
              `notes` backend присылает готовыми строками («промокод не применён:
              минимальная сумма…»). Показываем их дословно и без смягчения: если
              код не сработал, покупатель должен об этом знать до оплаты.
            */}
            {preview && preview.notes.length > 0 ? (
              <ul className="mt-4 space-y-1.5 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-3 text-sm text-amber-900">
                {preview.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            ) : null}

            <div className="mt-5 border-t border-slate-200 pt-5">
              <label htmlFor="comment" className="block text-sm font-medium text-slate-800">
                Комментарий к заказу
              </label>
              <textarea
                id="comment"
                name="comment"
                rows={2}
                maxLength={1000}
                defaultValue={values.comment}
                placeholder="Позвонить за час, упаковать двумя коробками"
                className="mt-1.5 w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-base text-slate-900 placeholder:text-slate-400"
              />
              {fields.comment ? <p className="mt-1 text-sm font-medium text-rose-600">{fields.comment}</p> : null}
            </div>
          </section>
        </div>

        {/* Шаг 7 */}
        <aside aria-labelledby="confirm-title" className="lg:sticky lg:top-20 lg:self-start">
          <div className="card p-5">
            <h2 id="confirm-title" className="text-lg font-semibold text-slate-900">
              <span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-pulse-100 text-xs font-bold text-pulse-800">
                7
              </span>
              Проверьте и подтвердите
            </h2>

            {preview ? (
              <>
                <Totals preview={preview} promoCode={preview.promo_code ?? ""} />

                {preview.promo_code === null && values.promo_code ? (
                  <p className="mt-3 text-xs text-amber-700">
                    Промокод «{values.promo_code}» не применён — итог посчитан без него.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-3 text-sm text-amber-900">
                {previewError
                  ? `Итог сейчас не рассчитан: ${previewError.message}`
                  : "Итог сейчас не рассчитан. Нажмите «Пересчитать» — и сумма появится здесь."}
              </p>
            )}

            {/*
              Блокировка оформления: кнопка не просто недоступна, а рядом
              написано, что именно чинить. Молчаливая кнопка была бы хуже
              сообщения об ошибке после нажатия.
            */}
            {blocked || !preview ? (
              <button
                type="submit"
                name="intent"
                value="create"
                disabled
                className="mt-5 w-full cursor-not-allowed rounded-xl bg-pulse-600 px-5 py-3 font-semibold text-white opacity-50"
              >
                {blocked ? "Оформление недоступно" : "Сначала пересчитайте"}
              </button>
            ) : (
              <button
                type="submit"
                name="intent"
                value="create"
                className="mt-5 w-full rounded-xl bg-pulse-600 px-5 py-3 font-semibold text-white transition-colors hover:bg-pulse-700"
              >
                Оформить заказ
              </button>
            )}

            <p className="mt-2 text-xs text-slate-500">
              Нажимая кнопку, вы соглашаетесь с условиями продажи. Заказ можно отменить в личном кабинете,
              пока он не собран.
            </p>
          </div>
        </aside>
      </Form>
    </Frame>
  );
}

/** Позиция корзины в форме предпросмотра: id может повторяться, поэтому sku. */
function toCartItemPreview(item: {
  id: string;
  product_name: string;
  sku: string | null;
  quantity: number;
  line_total: string;
}) {
  return {
    id: item.id,
    product_name: item.product_name,
    sku: item.sku ?? "",
    quantity: item.quantity,
    total_price: item.line_total,
  };
}

/**
 * Позиции, из-за которых оформление невозможно, — в том же виде, что отдаёт
 * предпросмотр: «Название: доступно N». Считаем по корзине, потому что её
 * `exceeds_stock` не зависит от успешности расчёта.
 */
function cartUnavailable(items: Cart["items"]): string[] {
  return items
    .filter((item) => item.exceeds_stock)
    .map((item) => `${item.product_name}: доступно ${item.available_quantity}`);
}

/** Общая рамка страницы: шапка + контейнер, как на остальных страницах. */
function Frame({ authenticated, children }: { authenticated: boolean; children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader authenticated={authenticated} />
      <main className="container-pulse flex-1 py-6 sm:py-10">{children}</main>
    </div>
  );
}