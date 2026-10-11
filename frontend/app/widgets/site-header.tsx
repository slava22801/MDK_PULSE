import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { Form, useRouteLoaderData } from "react-router";

import { useAuthStore } from "~/stores/auth";
import { useCartStore } from "~/stores/cart";
import { useFavoritesStore } from "~/stores/favorites";

import {
  ChartColumn,
  ChevronDown,
  Heart,
  MapPin,
  Menu,
  Search,
  ShoppingCart,
  UserRound,
  Zap,
} from "~/widgets/icons";

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

/** Быстрые разделы третьей полосы макета. */
const QUICK_LINKS = [
  { label: "Видеокарты", href: "/catalog/videokarty" },
  { label: "Процессоры", href: "/catalog/processory" },
  { label: "Память и накопители", href: "/catalog/operativnaya-pamyat" },
  { label: "Периферия", href: "/catalog/periferiya" },
  { label: "Собрать ПК", href: "/catalog/sborka-pk" },
  { label: "Бренды", href: "/catalog/brendy" },
];

/** Сервисные ссылки верхней полосы. */
const SERVICE_LINKS = [
  { label: "Доставка и оплата", href: "/catalog" },
  { label: "Гарантия и возврат", href: "/catalog" },
  { label: "Магазины", href: "/catalog" },
];

/**
 * Значок-подпись шапки: иконка, основная подпись и вторая строка мелким шрифтом.
 *
 * Вторая строка в макете занята счётчиками («3 товара») и подсказкой
 * («Регистрация»), поэтому она необязательна.
 */
function HeaderAction({
  icon,
  label,
  hint,
  href,
  count,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  href?: string;
  count?: number;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className="relative">
        {icon}
        {count !== undefined && count > 0 ? (
          <span className="absolute -top-1.5 -right-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-pulse-600 px-1 text-[0.625rem] leading-none font-bold text-white">
            {count > 99 ? "99+" : count}
          </span>
        ) : null}
      </span>
      <span className="text-xs font-semibold whitespace-nowrap text-slate-900">{label}</span>
      {hint ? (
        <span className="text-[0.625rem] leading-tight whitespace-nowrap text-slate-600">{hint}</span>
      ) : null}
    </>
  );

  const className =
    "flex flex-col items-center gap-0.5 rounded-control px-1.5 py-1 transition-opacity hover:opacity-70";

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={className}>
        {content}
      </button>
    );
  }

  return (
    <a
      href={href}
      className={className}
      aria-label={count !== undefined && count > 0 ? `${label}, товаров: ${count}` : label}
    >
      {content}
    </a>
  );
}

/**
 * Шапка магазина — три полосы по макету:
 * сервисная навигация, основная навигация и быстрые разделы.
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

  const cartHint = cartCount > 0 ? `${cartCount} товаров` : "Пока пусто";
  const favoritesHint = favoritesCount > 0 ? `${favoritesCount} товаров` : "Пока пусто";

  return (
    <header className="sticky top-0 z-40 bg-white shadow-card">
      {/* Полоса 1: город, сервисные ссылки и телефон. */}
      <div className="hidden h-10 items-center justify-between bg-slate-50 px-4 sm:flex lg:px-8 xl:px-16">
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-pill px-1 py-0.5 text-[0.8125rem] font-semibold text-slate-900 transition-opacity hover:opacity-70"
        >
          <MapPin className="h-[0.9375rem] w-[0.9375rem] text-pulse-600" />
          Москва
          <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
        </button>

        <div className="flex items-center gap-7">
          {SERVICE_LINKS.map((link) => (
            <a
              key={link.label}
              href={link.href}
              className="text-[0.8125rem] text-slate-600 transition-colors hover:text-pulse-600"
            >
              {link.label}
            </a>
          ))}
          <a
            href="tel:88007002424"
            className="text-[0.8125rem] font-semibold text-slate-900 transition-opacity hover:opacity-70"
          >
            8 800 700-24-24
          </a>
        </div>
      </div>

      {/* Полоса 2: логотип, каталог, поиск и пользовательские действия. */}
      <div className="flex h-[4.5rem] items-center gap-6 px-4 lg:px-8 xl:px-16">
        <a href="/" className="flex shrink-0 items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-control bg-pulse-600 text-white">
            <Zap className="h-6 w-6" strokeWidth={2} />
          </span>
          <span className="text-[1.8125rem] leading-none font-extrabold tracking-tight text-slate-900">
            пульс
          </span>
        </a>

        <a
          href="/catalog"
          className="hidden h-11 shrink-0 items-center gap-2 rounded-control bg-pulse-600 px-[1.125rem] text-[0.9375rem] font-semibold text-white transition-colors hover:bg-pulse-700 sm:inline-flex"
        >
          <Menu className="h-5 w-5" />
          Каталог
        </a>

        {/* Поиск — обычная GET-форма: она ведёт в каталог и работает без
            JavaScript, а её результат выглядит как обычная страница с
            фильтрами, поэтому его можно отправить ссылкой. */}
        <Form
          method="get"
          action="/catalog"
          role="search"
          className="flex h-[2.875rem] min-w-0 flex-1 items-center justify-between gap-2 rounded-control border border-slate-200 bg-slate-50 px-4 focus-within:border-pulse-400 focus-within:bg-white"
        >
          <label htmlFor="site-search" className="sr-only">
            Поиск по каталогу
          </label>
          <input
            id="site-search"
            type="search"
            name="q"
            placeholder="Товар, артикул или бренд"
            className="min-w-0 flex-1 bg-transparent text-sm text-slate-900 placeholder:text-slate-600 focus:outline-none"
          />
          <button type="submit" aria-label="Найти" className="shrink-0 text-slate-600 hover:text-pulse-600">
            <Search className="h-5 w-5" />
          </button>
        </Form>

        <div className="flex shrink-0 items-center gap-5.5">
          {authenticated ? (
            <>
              <HeaderAction
                icon={<UserRound className="h-5 w-5 text-slate-900" />}
                label="Кабинет"
                href="/account"
              />
              <form method="post" action="/logout" onSubmit={handleLogout}>
                <button
                  type="submit"
                  disabled={pending}
                  className="text-[0.625rem] leading-tight whitespace-nowrap text-slate-600 transition-colors hover:text-pulse-600 disabled:opacity-50"
                >
                  Выйти
                </button>
              </form>
            </>
          ) : (
            <HeaderAction
              icon={<UserRound className="h-5 w-5 text-slate-900" />}
              label="Войти"
              hint="Регистрация"
              href="/login"
            />
          )}

          {/* Избранное показываем и гостю: `/favorites` гостю отвечает 401,
              но сама страница объясняет это и предлагает войти — молчаливая
              кнопка была бы хуже явной. */}
          <span className="hidden sm:contents">
            <HeaderAction
              icon={<Heart className="h-5 w-5 text-slate-900" />}
              label="Избранное"
              hint={favoritesHint}
              href="/favorites"
              count={favoritesCount}
            />
          </span>

          <span className="hidden md:contents">
            <HeaderAction
              icon={<ChartColumn className="h-5 w-5 text-slate-900" />}
              label="Сравнение"
              href="/compare"
            />
          </span>

          <HeaderAction
            icon={<ShoppingCart className="h-5 w-5 text-pulse-600" />}
            label="Корзина"
            hint={cartHint}
            href="/cart"
            count={cartCount}
          />
        </div>
      </div>

      {/* Полоса 3: быстрые разделы. */}
      <nav
        aria-label="Быстрые разделы"
        className="flex h-12 items-center gap-6 overflow-x-auto border-t border-slate-200 px-4 whitespace-nowrap lg:justify-between lg:px-8 xl:px-16"
      >
        <a
          href="/catalog"
          className="shrink-0 text-sm font-semibold text-pulse-600 transition-colors hover:text-pulse-700"
        >
          Акции и скидки
        </a>
        {QUICK_LINKS.map((link) => (
          <a
            key={link.label}
            href={link.href}
            className="shrink-0 text-sm font-medium text-slate-900 transition-opacity hover:opacity-60"
          >
            {link.label}
          </a>
        ))}
      </nav>
    </header>
  );
}