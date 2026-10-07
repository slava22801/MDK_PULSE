import type { FormEvent, ReactNode } from "react";
import { useEffect, useState } from "react";
import { Form, useRouteLoaderData } from "react-router";

import { useAuthStore } from "~/stores/auth";
import { useCartStore } from "~/stores/cart";
import { useFavoritesStore } from "~/stores/favorites";

/** Данные корневого loader'а — источник счётчиков (см. `app/root.tsx`). */
type RootData = {
  authenticated: boolean;
  cartCount: number;
  favoritesCount: number;
  favoritesIds: string[];
};

type SiteHeaderProps = {
  /**
   * Признак сессии, вычисленный loader-ом из cookie.
   *
   * Именно он, а не стор, решает что показать на первом рендере: на сервере
   * localStorage недоступен, и без этого пропса авторизованный пользователь
   * получил бы «Войти» до гидратации — то есть расхождение разметки SSR и клиента.
   */
  authenticated: boolean;
};

/** Значок с числом: показываем, только когда есть что считать. */
function Counter({ count, children }: { count: number; children: ReactNode }) {
  return (
    <>
      {children}
      {count > 0 ? (
        <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-[0.65rem] leading-none font-bold text-white">
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </>
  );
}

/**
 * Общая шапка магазина.
 *
 * Ссылки намеренно обычные `<a>`, а не `<Link>`: часть маршрутов (например,
 * /account) в loader обращается к backend через serverFetch, который на клиенте
 * не работает. Полная перезагрузка гарантирует, что такой loader выполнится на
 * сервере, где есть доступ к API_INTERNAL_URL.
 *
 * Счётчики приходят из корневого loader'а и раскладываются в сторы. Синхронизация
 * живёт в `useEffect` намеренно: стор — модульный синглтон, и наполнять его во
 * время SSR означало бы отдать счётчик одного пользователя другому.
 * Благодаря этому после «В корзину» на карточке число в шапке меняется сразу,
 * без перезагрузки страницы.
 */
export function SiteHeader({ authenticated }: SiteHeaderProps) {
  const hydrateAuth = useAuthStore((state) => state.hydrate);
  const logout = useAuthStore((state) => state.logout);
  const [pending, setPending] = useState(false);

  const rootData = useRouteLoaderData<RootData>("root");
  const cartCount = useCartStore((state) => state.cart.totals.items_count);
  const favoritesCount = useFavoritesStore((state) => state.ids.length);
  const seedCartCount = useCartStore((state) => state.seedCount);
  const syncFavorites = useFavoritesStore((state) => state.sync);

  // Стор наполняется на клиенте: сервер токены видит только из cookie.
  // `hydrate` идемпотентен, поэтому повторный вызов на других страницах безвреден.
  useEffect(() => {
    hydrateAuth();
  }, [hydrateAuth]);

  useEffect(() => {
    if (!rootData) return;
    seedCartCount(rootData.cartCount);
    syncFavorites(rootData.favoritesIds);
  }, [rootData, seedCartCount, syncFavorites]);

  const handleLogout = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    try {
      await logout();
    } finally {
      // Полная перезагрузка, чтобы главная отрисовалась уже без cookie.
      window.location.assign("/");
    }
  };

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
      <div className="container-pulse flex h-16 items-center gap-4">
        <a href="/" className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 items-center justify-center rounded-xl bg-pulse-600 text-white"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor">
              <path
                d="M2 12h4l3-8 4 16 3-8h6"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="text-xl font-bold tracking-tight text-slate-900">ПУЛЬС</span>
        </a>

        <nav aria-label="Основное меню" className="hidden items-center gap-6 md:flex">
          <a href="/catalog" className="text-sm font-medium text-slate-700 hover:text-pulse-700">
            Каталог
          </a>
          <a href="/compare" className="text-sm font-medium text-slate-700 hover:text-pulse-700">
            Сравнение
          </a>
          <a href="/favorites" className="text-sm font-medium text-slate-700 hover:text-pulse-700">
            Избранное
          </a>
        </nav>

        {/* Поиск — обычная GET-форма: она ведёт в каталог и работает без
            JavaScript, а её результат выглядит как обычная страница с
            фильтрами, поэтому его можно отправить ссылкой. */}
        <Form
          method="get"
          action="/catalog"
          role="search"
          className="ms-auto hidden max-w-xs flex-1 items-center gap-2 sm:flex"
        >
          <label htmlFor="site-search" className="sr-only">
            Поиск по каталогу
          </label>
          <input
            id="site-search"
            type="search"
            name="q"
            placeholder="Ryzen 7, SSD 2 ТБ…"
            className="w-full flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400"
          />
          <button
            type="submit"
            className="shrink-0 rounded-lg bg-pulse-600 px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-pulse-700"
          >
            Найти
          </button>
        </Form>

        <div className="ml-auto flex items-center gap-2 sm:ml-0">
          {/* Избранное показываем и гостю: `/favorites` гостю отвечает 401,
              но сама страница объясняет это и предлагает войти — молчаливая
              кнопка была бы хуже явной. */}
          <a
            href="/favorites"
            className="relative rounded-lg px-2.5 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100"
            aria-label={
              favoritesCount > 0
                ? `Избранное, товаров: ${favoritesCount}`
                : "Избранное"
            }
          >
            <Counter count={favoritesCount}>
              <span className="hidden sm:inline">Избранное</span>
              <span className="sm:hidden" aria-hidden="true">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor">
                  <path
                    d="M20.8 6.6a5 5 0 00-7.1 0L12 8.3l-1.7-1.7a5 5 0 10-7.1 7.1L12 22l8.8-8.3a5 5 0 000-7.1z"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span className="sr-only sm:hidden">Избранное</span>
            </Counter>
          </a>

          <a
            href="/cart"
            className="relative inline-flex items-center rounded-lg bg-pulse-600 px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-pulse-700"
            aria-label={cartCount > 0 ? `Корзина, товаров: ${cartCount}` : "Корзина"}
          >
            <Counter count={cartCount}>Корзина</Counter>
          </a>

          {authenticated ? (
            <>
              <a
                href="/account"
                className="rounded-lg px-2.5 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100"
              >
                Кабинет
              </a>
              <form method="post" action="/logout" onSubmit={handleLogout}>
                <button
                  type="submit"
                  disabled={pending}
                  className="rounded-lg px-2.5 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-50"
                >
                  <span className="hidden sm:inline">Выйти</span>
                  <span className="sm:hidden" aria-hidden="true">
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor">
                      <path
                        d="M15 17l5-5-5-5M20 12H9M12 20H6a2 2 0 01-2-2V6a2 2 0 012-2h6"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                  <span className="sr-only sm:hidden">Выйти</span>
                </button>
              </form>
            </>
          ) : (
            <a
              href="/login"
              className="rounded-lg px-2.5 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100"
            >
              Войти
            </a>
          )}
        </div>
      </div>
    </header>
  );
}