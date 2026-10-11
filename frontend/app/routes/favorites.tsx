import { useEffect } from "react";
import { useFetcher } from "react-router";

import type { Route } from "./+types/favorites";

import type { Cart } from "~/lib/cart";
import { cartRequestHeaders } from "~/lib/cart";
import type { FavoriteItem, FavoritesOut } from "~/lib/favorites";
import { priceDeltaLabel } from "~/lib/favorites";
import { describeApiError } from "~/lib/api-error";
import { ApiError, serverFetch } from "~/lib/api.server";
import { readAccessToken } from "~/lib/auth-token";
import { plural } from "~/lib/format";
import { useAuthStore } from "~/stores/auth";
import { useCartStore } from "~/stores/cart";
import { useFavoritesStore } from "~/stores/favorites";
import { AvailabilityBadge, ProductCardTile } from "~/widgets/product-card";
import { SiteHeader } from "~/widgets/site-header";
import { SiteFooter } from "~/widgets/site-footer";

export function meta(): Route.MetaDescriptors {
  return [
    { title: "Избранное — ПУЛЬС" },
    { name: "description", content: "Отложенные товары: следите за ценой и возвратом в наличие." },
    { name: "robots", content: "noindex" },
  ];
};

/**
 * Избранное `/favorites`.
 *
 * В отличие от корзины, избранное живёт только в аккаунте: гостю `/favorites`
 * отвечает 401. Поэтому гостя мы НЕ редиректим — показываем понятное
 * предложение войти, иначе человек потеряет контекст и решит, что ссылка
 * в шапке сломана.
 *
 * «В корзину» — это настоящий `POST /cart/items`, поэтому гость может
 * пользоваться избранным наравне с авторизованным.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const token = readAccessToken(request, useAuthStore.getState().accessToken);
  if (!token) return { ok: true as const, authenticated: false, favorites: null, error: null };

  try {
    const favorites = await serverFetch<FavoritesOut>("/favorites", {
      headers: cartRequestHeaders(request, token),
    });
    return { ok: true as const, authenticated: true, favorites, error: null };
  } catch (cause) {
    return {
      ok: false as const,
      authenticated: true,
      favorites: null,
      error: describeApiError(cause, "Не удалось загрузить избранное"),
    };
  }
}

export async function action({ request }: Route.ActionArgs) {
  const token = readAccessToken(request, useAuthStore.getState().accessToken);
  if (!token) return { error: "Войдите, чтобы пользоваться избранным" };

  const headers = { ...cartRequestHeaders(request, token), "Content-Type": "application/json" };
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const productId = String(form.get("product_id") ?? "");
  if (!productId) return { error: "Не найден товар" };

  try {
    if (intent === "remove") {
      await serverFetch<unknown>(`/favorites/${encodeURIComponent(productId)}`, {
        method: "DELETE",
        headers,
      });
      return null;
    }

    if (intent === "add_to_cart") {
      // Ответ здесь — CartOut: кладём его в стор целиком, чтобы счётчик в
      // шапке совпал с сервером, а не с догадкой клиента.
      const cart = await serverFetch<Cart>("/cart/items", {
        method: "POST",
        headers,
        body: JSON.stringify({ product_id: productId, quantity: 1 }),
      });
      return { cart, message: cart.notices[0]?.message ?? "Товар добавлен в корзину" };
    }

    return { error: "Неизвестное действие" };
  } catch (cause) {
    return {
      error: describeApiError(cause, "Не удалось выполнить действие").message,
      status: cause instanceof ApiError ? cause.status : 0,
    };
  }
}

/* ──────────────────────────── карточка позиции ─────────────────────────── */

/**
 * Бейджи «цена изменилась» и «снова в наличии» — ради них избранным и
 * пользуются. Знак берём из `price_delta`: минус — подешевел, и это повод
 * купить, поэтому подсветка разная.
 */
function AttentionBadges({ item }: { item: FavoriteItem }) {
  const delta = priceDeltaLabel(item.price_delta);
  const showPrice = item.price_changed && delta !== null;

  if (!showPrice && !item.back_in_stock) return null;

  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {showPrice && delta ? (
        <span
          className={`rounded-lg px-2 py-0.5 text-xs font-bold ${
            delta.tone === "down" ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"
          }`}
        >
          {delta.tone === "down" ? "Подешевел на " : "Подорожал на "}
          {delta.text}
        </span>
      ) : null}
      {item.back_in_stock ? (
        <span className="rounded-lg bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-800">
          Снова в наличии
        </span>
      ) : null}
    </div>
  );
}

function FavoriteTile({ item }: { item: FavoriteItem }) {
  const addFetcher = useFetcher<{ cart?: Cart; error?: string; message?: string }>();
  const removeFetcher = useFetcher<{ error?: string }>();
  const hydrateCart = useCartStore((state) => state.hydrate);

  const busy = addFetcher.state !== "idle" || removeFetcher.state !== "idle";
  const addError = addFetcher.data?.error ?? null;
  const addedMessage = addFetcher.data?.message ?? null;
  const removeError = removeFetcher.data?.error ?? null;

  // Ответ action'а — источник правды для счётчика шапки.
  useEffect(() => {
    if (addFetcher.data?.cart) hydrateCart(addFetcher.data.cart);
  }, [addFetcher.data, hydrateCart]);

  const unavailable = item.availability === "out_of_stock" || item.availability === "discontinued";

  return (
    <li className="card flex flex-col p-3.5">
      <AttentionBadges item={item} />

      <a href={`/product/${item.slug}`} className="block">
        <ProductCardTile product={item} className="border-0 shadow-none" />
      </a>

      <div className="mt-3 space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <AvailabilityBadge availability={item.availability} quantity={item.available_quantity} />
          <span className="text-slate-400">Добавлен {formatDateOnly(item.added_at)}</span>
        </div>

        <addFetcher.Form method="post">
          <input type="hidden" name="intent" value="add_to_cart" />
          <input type="hidden" name="product_id" value={item.id} />
          <button
            type="submit"
            disabled={busy || unavailable}
            className="w-full rounded-xl bg-pulse-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-pulse-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {unavailable
              ? "Нет в наличии"
              : addFetcher.state !== "idle"
                ? "Добавляем…"
                : "В корзину"}
          </button>
        </addFetcher.Form>

        <removeFetcher.Form method="post">
          <input type="hidden" name="intent" value="remove" />
          <input type="hidden" name="product_id" value={item.id} />
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:border-rose-300 hover:text-rose-700 disabled:opacity-60"
          >
            Удалить из избранного
          </button>
        </removeFetcher.Form>

        {addError || removeError || addedMessage ? (
          <p
            role="status"
            className={`text-xs leading-snug ${addError || removeError ? "text-rose-600" : "text-emerald-700"}`}
          >
            {addError ?? removeError ?? addedMessage}
          </p>
        ) : null}
      </div>
    </li>
  );
}

/** Формат даты добавления без времени: точность здесь не нужна. */
function formatDateOnly(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

/* ─────────────────────────────── страница ─────────────────────────────── */

export default function Favorites({ loaderData }: Route.ComponentProps) {
  const { authenticated } = loaderData;
  const syncFavorites = useFavoritesStore((state) => state.sync);
  const ids = useFavoritesStore((state) => state.ids);

  // После удаления позиции loader вернётся уже без неё, и набор id в сторе
  // должен уменьшиться — иначе сердечки на других страницах останутся залитыми.
  useEffect(() => {
    if (loaderData.favorites) syncFavorites(loaderData.favorites.items.map((item) => item.id));
  }, [loaderData.favorites, syncFavorites]);

  if (!authenticated) {
    return (
      <div className="flex min-h-full flex-col">
        <SiteHeader authenticated={false} />
        <main className="container-pulse flex-1 py-10 sm:py-14">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">Избранное</h1>
          <div className="card mt-6 p-8 text-center sm:p-12">
            <p aria-hidden="true" className="text-4xl">
              ♡
            </p>
            <h2 className="mt-4 text-lg font-semibold text-slate-900">
              Избранное доступно после входа
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">
              Избранное хранится в личном кабинете, поэтому доступно только авторизованным. Войдите —
              и отложенные товары появятся здесь вместе с сигналами об изменении цены.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <a
                href="/login"
                className="rounded-xl bg-pulse-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-pulse-700"
              >
                Войти
              </a>
              <a
                href="/register"
                className="rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
              >
                Зарегистрироваться
              </a>
            </div>
          </div>
        </main>
        <SiteFooter />
      </div>
    );
  }

  const items = loaderData.favorites?.items ?? [];

  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader authenticated />

      <main className="container-pulse flex-1 py-6 sm:py-10">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">Избранное</h1>
        <p className="mt-1.5 text-sm text-slate-600" aria-live="polite">
          {loaderData.favorites
            ? `${ids.length} ${plural(ids.length, "товар", "товара", "товаров")}`
            : "Загружаем избранное…"}
        </p>

        {!loaderData.ok ? (
          <div role="alert" className="card mt-6 border-rose-200 bg-rose-50 p-6 text-center">
            <p className="text-sm font-semibold text-rose-700">Не удалось загрузить избранное</p>
            <p className="mt-2 text-sm text-slate-700">{loaderData.error?.message}</p>
          </div>
        ) : items.length === 0 ? (
          <div className="card mt-6 p-8 text-center sm:p-12">
            <p aria-hidden="true" className="text-4xl">
              ♡
            </p>
            <h2 className="mt-4 text-lg font-semibold text-slate-900">Здесь пока пусто</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">
              Отмечайте товары сердечком в каталоге — мы покажем, если цена изменится или товар вернётся
              в наличие.
            </p>
            <a
              href="/catalog"
              className="mt-6 inline-block rounded-xl bg-pulse-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-pulse-700"
            >
              Перейти в каталог
            </a>
          </div>
        ) : (
          <>
            {loaderData.favorites && loaderData.favorites.attention_count > 0 ? (
              <p className="mt-4 rounded-card border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                {loaderData.favorites.attention_count}{" "}
                {plural(loaderData.favorites.attention_count, "товар требует", "товара требуют", "товаров требуют")}{" "}
                внимания: изменилась цена или товар снова в наличии.
              </p>
            ) : null}

            <ul className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {items.map((item) => (
                <FavoriteTile key={item.id} item={item} />
              ))}
            </ul>

            <p className="mt-6 text-xs text-slate-500">
              {/* Обычная ссылка, а не <Link>: клиентский переход выполнил бы
                  loader /cart в браузере, где serverFetch недоступен. */}
              Цены обновляются при открытии страницы. Корзина доступна и гостю —{" "}
              <a href="/cart" className="font-medium text-pulse-700 hover:text-pulse-800">
                перейти в корзину
              </a>
              .
            </p>
          </>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}