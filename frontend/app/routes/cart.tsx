import type { Route } from "./+types/cart";
import { useEffect } from "react";
import { useFetcher } from "react-router";

import type { Cart, CartItem } from "~/lib/cart";
import { cartBlockingItems, cartRequestHeaders, MAX_CART_QUANTITY, MIN_CART_QUANTITY } from "~/lib/cart";
import { describeApiError } from "~/lib/api-error";
import { ApiError, serverFetch } from "~/lib/api.server";
import { readAccessToken } from "~/lib/auth-token";
import { formatPrice, plural } from "~/lib/format";
import { useAuthStore } from "~/stores/auth";
import { useCartStore } from "~/stores/cart";
import { AvailabilityBadge, ProductImageFrame } from "~/widgets/product-card";
import { SiteHeader } from "~/widgets/site-header";

export function meta(): Route.MetaDescriptors {
  return [
    { title: "Корзина — ПУЛЬС" },
    { name: "description", content: "Корзина заказа: позиции, остатки и итоговая стоимость." },
    { name: "robots", content: "noindex" },
  ];
}

/**
 * Корзина `/cart`.
 *
 * Единственный источник правды — ответ `/cart`: стора здесь почти нет, он
 * нужен только ради счётчика в шапке. Поэтому количество, удаление позиции и
 * очистка идут через `action` и `useFetcher`, а после любой мутации React
 * Router сам перезапрашивает loader — список не может разойтись с сервером.
 *
 * Такой путь ещё и работает без JavaScript: тот же `action` обслуживает
 * обычную отправку формы.
 *
 * Гостю страница доступна: идентификатор его корзины backend держит в cookie
 * `pulse_cart`, а loader пересылает её при SSR-запросе (см. `~/lib/cart`).
 */
export async function loader({ request }: Route.LoaderArgs) {
  const token = readAccessToken(request, useAuthStore.getState().accessToken);

  try {
    const cart = await serverFetch<Cart>("/cart", { headers: cartRequestHeaders(request, token) });
    return { ok: true as const, authenticated: Boolean(token), cart };
  } catch (cause) {
    return {
      ok: false as const,
      authenticated: Boolean(token),
      error: describeApiError(cause, "Не удалось загрузить корзину"),
    };
  }
}

/** Одна позиция: количество приходит строкой, поэтому Number.parseInt. */
function readQuantity(raw: FormDataEntryValue | null): number | null {
  const value = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(value)) return null;
  return Math.min(MAX_CART_QUANTITY, Math.max(MIN_CART_QUANTITY, value));
}

/**
 * Какое количество отправила форма позиции.
 *
 * Кнопки ± не несут своё значение полем `quantity` — иначе браузер отправил бы
 * два одноимённых поля, и результат зависел бы от порядка элементов в DOM.
 * Вместо этого они шлют шаг `quantity_step`, а `current` содержит то, что
 * сейчас в корзине. Форма без шага — это обычная отправка поля ввода.
 */
function resolveQuantity(form: FormData): number | null {
  const step = Number.parseInt(String(form.get("quantity_step") ?? ""), 10);
  if (Number.isFinite(step) && step !== 0) {
    const current = readQuantity(form.get("current"));
    return current === null ? null : readQuantity(String(current + step));
  }
  return readQuantity(form.get("quantity"));
}

export async function action({ request }: Route.ActionArgs) {
  const token = readAccessToken(request, useAuthStore.getState().accessToken);
  const headers = { ...cartRequestHeaders(request, token), "Content-Type": "application/json" };

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    if (intent === "clear") {
      await serverFetch<Cart>("/cart", { method: "DELETE", headers });
      return null;
    }

    const itemId = String(form.get("item_id") ?? "");
    if (!itemId) return { intent, error: "Не найдена позиция корзины" };

    if (intent === "remove") {
      await serverFetch<Cart>(`/cart/items/${encodeURIComponent(itemId)}`, { method: "DELETE", headers });
      return null;
    }

    if (intent === "set") {
      const quantity = resolveQuantity(form);
      if (quantity === null) return { intent, error: "Укажите количество от 1 до 99" };
      await serverFetch<Cart>(`/cart/items/${encodeURIComponent(itemId)}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ quantity }),
      });
      return null;
    }

    return { intent, error: "Неизвестное действие с корзиной" };
  } catch (cause) {
    // 422/400 от backend-а — это ответ на конкретное действие пользователя,
    // поэтому возвращаем его в данных fetcher'а рядом со строкой позиции,
    // а не роняем всю страницу.
    return {
      intent,
      itemId: String(form.get("item_id") ?? ""),
      error: describeApiError(cause, "Не удалось изменить корзину").message,
      status: cause instanceof ApiError ? cause.status : 0,
    };
  }
}

/* ─────────────────────────── блок уведомлений ─────────────────────────── */

/**
 * Требование ТЗ 5.8: если товара оказалось меньше, чем просил пользователь,
 * сказать об этом явно. `notices` приходят от backend-а уже с готовым
 * человекочитаемым текстом — показываем его дословно и добавляем кнопку,
 * которая молча приводит количество к остатку.
 */
function Notices({ cart }: { cart: Cart }) {
  if (cart.notices.length === 0) return null;

  return (
    <section
      aria-label="Предупреждения по позициям корзины"
      className="mb-5 rounded-card border border-amber-300 bg-amber-50 p-4 sm:p-5"
    >
      <h2 className="flex items-center gap-2 text-base font-semibold text-amber-900">
        <span aria-hidden="true">⚠</span>
        Часть товаров пришлось уменьшить
      </h2>
      <ul className="mt-3 space-y-2.5">
        {cart.notices.map((notice) => {
          const item = cart.items.find((candidate) => candidate.product_id === notice.product_id);
          return (
            <li
              key={notice.product_id}
              className="rounded-xl border border-amber-200 bg-white px-3.5 py-3 text-sm text-slate-800"
            >
              <p className="font-medium">{notice.message}</p>
              <p className="mt-1 text-xs text-slate-500">
                Запрошено {notice.requested} {plural(notice.requested, "шт.", "шт.", "шт.")}, доступно{" "}
                {notice.available} {plural(notice.available, "шт.", "шт.", "шт.")}
              </p>
              {item ? (
                <FixQuantityForm itemId={item.id} quantity={notice.available} className="mt-2" />
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Отдельная форма, чтобы кнопка «уменьшить» не вкладывалась в форму количества. */
function FixQuantityForm({
  itemId,
  quantity,
  className,
}: {
  itemId: string;
  quantity: number;
  className?: string;
}) {
  return (
    <CartForm className={className}>
      <input type="hidden" name="intent" value="set" />
      <input type="hidden" name="item_id" value={itemId} />
      <input type="hidden" name="quantity" value={quantity} />
      <button
        type="submit"
        className="rounded-lg border border-amber-400 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-900 transition-colors hover:bg-amber-100"
      >
        Оставить {quantity} {plural(quantity, "шт.", "шт.", "шт.")}
      </button>
    </CartForm>
  );
}

/** Форма-обёртка: даёт кнопке свой fetcher и снимает перерисовку всей страницы. */
function CartForm({
  children,
  className,
  busyLabel,
}: {
  children: React.ReactNode;
  className?: string;
  busyLabel?: string;
}) {
  const fetcher = useFetcher();
  return (
    <fetcher.Form method="post" className={className}>
      {children}
      <span className="sr-only" role="status" aria-live="polite">
        {fetcher.state !== "idle" ? (busyLabel ?? "Сохраняем…") : ""}
      </span>
    </fetcher.Form>
  );
}

/* ──────────────────────────── строка позиции ───────────────────────────── */

function CartRow({ item }: { item: CartItem }) {
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const error = fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;
  const max = Math.min(MAX_CART_QUANTITY, Math.max(item.available_quantity, MIN_CART_QUANTITY));

  return (
    <li
      className={`card p-3.5 sm:p-4 ${item.exceeds_stock ? "border-rose-300 bg-rose-50/40" : ""}`}
    >
      <div className="flex gap-3 sm:gap-4">
        <a href={`/product/${item.product_slug}`} className="w-20 shrink-0 sm:w-28">
          {/* Виджет ожидает `name`, а позиция корзины называет его `product_name`. */}
          <ProductImageFrame
            product={{ name: item.product_name, image_url: item.image_url, image_alt: item.image_alt, category: item.category }}
            className="rounded-xl"
          />
          <span className="sr-only">{item.product_name}</span>
        </a>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
            <div className="min-w-0">
              <a
                href={`/product/${item.product_slug}`}
                className="font-medium text-slate-900 hover:text-pulse-700"
              >
                {item.product_name}
              </a>
              <p className="mt-0.5 text-xs text-slate-500">
                {item.brand_name ?? "Без бренда"}
                {item.sku ? ` · ${item.sku}` : ""}
              </p>
            </div>
            <div className="text-right">
              <p className="text-base font-bold text-slate-900">{formatPrice(item.line_total)}</p>
              {item.quantity > 1 ? (
                <p className="text-xs text-slate-500">
                  {formatPrice(item.unit_price)} × {item.quantity}
                </p>
              ) : null}
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <AvailabilityBadge
              availability={item.availability}
              quantity={item.available_quantity}
            />
            {item.exceeds_stock ? (
              <span className="font-semibold text-rose-700">
                Запрошено больше, чем есть в наличии
              </span>
            ) : null}
          </div>

          {/*
            Количество: шаг задаётся отдельной кнопкой `quantity_step`, а не
            значением самой кнопки ±. Иначе браузер отправил бы два поля
            `quantity` — из поля ввода и из кнопки — и результат зависел бы от
            порядка элементов в DOM. Так намерение читается однозначно, и форма
            работает без JavaScript.
          */}
          <fetcher.Form method="post" className="mt-3 flex flex-wrap items-center gap-2">
            <input type="hidden" name="intent" value="set" />
            <input type="hidden" name="item_id" value={item.id} />
            <input type="hidden" name="current" value={item.quantity} />

            <div className="inline-flex items-center rounded-xl border border-slate-300 bg-white">
              <button
                type="submit"
                name="quantity_step"
                value="-1"
                disabled={busy || item.quantity <= MIN_CART_QUANTITY}
                aria-label={`Уменьшить количество: ${item.product_name}`}
                className="px-3 py-1.5 text-lg leading-none text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-300"
              >
                −
              </button>
              <label htmlFor={`qty-${item.id}`} className="sr-only">
                Количество: {item.product_name}
              </label>
              <input
                id={`qty-${item.id}`}
                name="quantity"
                type="number"
                inputMode="numeric"
                min={MIN_CART_QUANTITY}
                max={MAX_CART_QUANTITY}
                defaultValue={item.quantity}
                className="w-14 border-x border-slate-300 px-1 py-1.5 text-center text-sm font-medium text-slate-900"
              />
              <button
                type="submit"
                name="quantity_step"
                value="1"
                disabled={busy || item.quantity >= max}
                aria-label={`Увеличить количество: ${item.product_name}`}
                className="px-3 py-1.5 text-lg leading-none text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-300"
              >
                +
              </button>
            </div>

            {/* Кнопка без `name`: отправляет значение поля, а не своё. */}
            <button
              type="submit"
              disabled={busy}
              className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-60"
            >
              Изменить
            </button>

            <CartForm className="ms-auto">
              <input type="hidden" name="intent" value="remove" />
              <input type="hidden" name="item_id" value={item.id} />
              <button
                type="submit"
                disabled={busy}
                className="rounded-xl px-3 py-1.5 text-sm font-medium text-rose-600 transition-colors hover:bg-rose-50 disabled:opacity-60"
              >
                Удалить
              </button>
            </CartForm>
          </fetcher.Form>

          {error ? (
            <p role="alert" className="mt-2 text-sm font-medium text-rose-600">
              {error}
            </p>
          ) : null}

          <span className="sr-only" role="status" aria-live="polite">
            {busy ? "Сохраняем количество…" : ""}
          </span>
        </div>
      </div>
    </li>
  );
}

/* ─────────────────────────────── страница ─────────────────────────────── */

export default function CartPage({ loaderData }: Route.ComponentProps) {
  // Счётчик в шапке живёт в сторе, а полная корзина — здесь. Раскладываем её
  // в стор после рендера, а не во время: стор — модульный синглтон, и запись
  // на этапе render отдала бы корзину одного запроса следующему.
  const hydrateCart = useCartStore((state) => state.hydrate);
  useEffect(() => {
    if (loaderData.ok) hydrateCart(loaderData.cart);
  }, [loaderData, hydrateCart]);

  // Ранний возврат, а не тернарная цепочка: после него TypeScript сужает
  // `loaderData` до успешной ветви, и в разметке не остаётся проверок на null,
  // которые ничего не дают читателю.
  if (!loaderData.ok) {
    return (
      <div className="flex min-h-full flex-col">
        <SiteHeader authenticated={loaderData.authenticated} />
        <main className="container-pulse flex-1 py-6 sm:py-10">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">Корзина</h1>
          <div role="alert" className="card mt-6 border-rose-200 bg-rose-50 p-6 text-center">
            <p className="text-sm font-semibold text-rose-700">
              {loaderData.error.status > 0 ? `Ошибка ${loaderData.error.status}` : "Нет связи с сервером"}
            </p>
            <p className="mt-2 text-sm text-slate-700">{loaderData.error.message}</p>
            <a
              href="/cart"
              className="mt-5 inline-block rounded-xl bg-pulse-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-pulse-700"
            >
              Попробовать снова
            </a>
          </div>
        </main>
      </div>
    );
  }

  const cart = loaderData.cart;

  if (cart.items.length === 0) {
    return (
      <div className="flex min-h-full flex-col">
        <SiteHeader authenticated={loaderData.authenticated} />
        <main className="container-pulse flex-1 py-6 sm:py-10">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">Корзина</h1>
          <div className="card mt-6 p-8 text-center sm:p-12">
            <p aria-hidden="true" className="text-4xl">
              🛒
            </p>
            <h2 className="mt-4 text-lg font-semibold text-slate-900">В корзине пока пусто</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">
              Выберите комплектующие в каталоге — корзина сохранится на сервере, даже если вы закроете
              вкладку.
            </p>
            <a
              href="/catalog"
              className="mt-6 inline-block rounded-xl bg-pulse-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-pulse-700"
            >
              Перейти в каталог
            </a>
          </div>
        </main>
      </div>
    );
  }

  const blocking = cartBlockingItems(cart);
  const totals = cart.totals;

  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader authenticated={loaderData.authenticated} />

      <main className="container-pulse flex-1 py-6 sm:py-10">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">Корзина</h1>

        <>
          <Notices cart={cart} />

          {blocking.length > 0 ? (
            <div
              role="alert"
              className="mb-5 rounded-card border border-rose-300 bg-rose-50 p-4 text-sm text-rose-900 sm:p-5"
            >
              <p className="font-semibold">Оформление пока недоступно</p>
              <p className="mt-1">
                В {blocking.length}{" "}
                {plural(blocking.length, "позиции", "позициях", "позициях")} запрошено больше, чем есть
                в наличии. Уменьшите количество — и заказ можно будет оформить.
              </p>
            </div>
          ) : null}

          <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <section aria-label="Позиции корзины">
              <ul className="space-y-3">
                {cart.items.map((item) => (
                  <CartRow key={item.id} item={item} />
                ))}
              </ul>

              <CartForm className="mt-4" busyLabel="Очищаем корзину…">
                <input type="hidden" name="intent" value="clear" />
                <button
                  type="submit"
                  className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:border-rose-300 hover:text-rose-700"
                >
                  Очистить корзину
                </button>
              </CartForm>
            </section>

            <aside aria-label="Итоги" className="lg:sticky lg:top-20 lg:self-start">
              <div className="card p-5">
                <h2 className="text-lg font-semibold text-slate-900">Итоги</h2>

                <dl className="mt-4 space-y-2 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-slate-600">
                      Товаров: {totals.items_count} {plural(totals.items_count, "шт.", "шт.", "шт.")}
                    </dt>
                    <dd className="font-medium text-slate-900">{formatPrice(totals.subtotal)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-slate-600">Скидка</dt>
                    <dd className="font-medium text-emerald-700">−{formatPrice(totals.discount_amount)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-slate-600">Доставка</dt>
                    <dd className="font-medium text-slate-900">
                      {totals.delivery_cost === "0" ? "бесплатно" : formatPrice(totals.delivery_cost)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3 border-t border-slate-200 pt-3 text-base">
                    <dt className="font-semibold text-slate-900">К оплате</dt>
                    <dd className="font-bold text-slate-900">{formatPrice(totals.total)}</dd>
                  </div>
                </dl>

                {cart.unavailable_count > 0 ? (
                  <p className="mt-3 text-xs text-amber-700">
                    Недоступных позиций: {cart.unavailable_count}{" "}
                    {plural(cart.unavailable_count, "шт.", "шт.", "шт.")}
                  </p>
                ) : null}

                {/*
                  Оформление — этап 5. Ссылка обычная, а не `<Link>`: loader
                  /checkout ходит в backend через serverFetch, которого в
                  браузере нет, поэтому переход должен быть полной
                  перезагрузкой (то же объяснение, что у ссылок в шапке).
                  При exceeds_stock переход закрыт — сначала количество к
                  остатку, иначе backend вернёт 409 insufficient_stock.
                */}
                {blocking.length > 0 ? (
                  <button
                    type="button"
                    disabled
                    className="mt-5 w-full cursor-not-allowed rounded-xl bg-pulse-600 px-5 py-3 font-semibold text-white opacity-50"
                  >
                    Перейти к оформлению
                  </button>
                ) : (
                  <a
                    href="/checkout"
                    className="mt-5 block w-full rounded-xl bg-pulse-600 px-5 py-3 text-center font-semibold text-white transition-colors hover:bg-pulse-700"
                  >
                    Перейти к оформлению
                  </a>
                )}
                <p className="mt-2 text-xs text-slate-500">
                  {blocking.length > 0
                    ? "Сначала приведите количество к остатку на складе."
                    : "Доставка, оплата и подтверждение — на одной странице."}
                </p>
              </div>
            </aside>
          </div>
        </>
      </main>
    </div>
  );
}