import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import type { Route } from "./+types/root";

import type { Cart } from "~/lib/cart";
import { cartRequestHeaders } from "~/lib/cart";
import type { FavoritesOut } from "~/lib/favorites";
import { serverFetch } from "~/lib/api.server";
import { readAccessToken } from "~/lib/auth-token";
import { useAuthStore } from "~/stores/auth";

import "./app.css";

export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
  // Inter из макета: без сети страница откатится на системный шрифт из
  // `app.css`, поэтому подключение необязательное, а не блокирующее.
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous" as const,
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap",
  },
];

/**
 * Счётчики для шапки.
 *
 * Один запрос на всё, кроме избранного: корзина нужна и гостю (cookie), и
 * авторизованному. Избранное гостю недоступно — `/favorites` отдал бы 401,
 * поэтому при отсутствии токена его не спрашиваем вовсе, а не гасим ошибку.
 *
 * Оба запроса не критичны для страницы: падение молча обнуляет счётчик,
 * потому что кнопка корзины должна работать даже когда API корзины лежит.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const token = readAccessToken(request, useAuthStore.getState().accessToken);
  const headers = cartRequestHeaders(request, token);

  // Запросы параллельны: корневой loader выполняется на каждой странице, и при
  // недоступном API два последовательных таймаута удваивали бы ожидание.
  const [cart, favorites] = await Promise.all([
    serverFetch<Cart>("/cart", { headers }).catch(() => null),
    // Избранное гостю недоступно: `/favorites` отдал бы 401, поэтому при
    // отсутствии токена его не спрашиваем вовсе, а не гасим ошибку.
    token
      ? serverFetch<FavoritesOut>("/favorites", { headers }).catch(() => null)
      : Promise.resolve(null),
  ]);

  return {
    authenticated: Boolean(token),
    cartCount: cart?.totals.items_count ?? 0,
    favoritesCount: favorites?.total ?? 0,
    /** Нужен кнопке «В избранное» на карточках, которые рендерит любая страница. */
    favoritesIds: (favorites?.items ?? []).map((item) => item.id),
  };
}

export function meta() {
  return [
    { title: "ПУЛЬС — интернет-магазин компьютерных комплектующих" },
    {
      name: "description",
      content:
        "Процессоры, видеокарты, SSD, оперативная память и комплектующие для сборки ПК. Гарантия, быстрая доставка, официальные поставки.",
    },
    { property: "og:title", content: "ПУЛЬС — комплектующие для ПК" },
    {
      property: "og:description",
      content: "Каталог компьютерных комплектующих: процессоры, видеокарты, накопители, БП.",
    },
    { property: "og:type", content: "website" },
  ];
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" className="h-full">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body className="flex min-h-full flex-col">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

/**
 * Единая обработка ошибок. Раздел 9 ТЗ требует отдельных состояний для
 * ошибки сервера, отсутствия сети и просроченного токена — здесь пользователь
 * хотя бы видит внятный текст вместо белого экрана.
 */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Что-то пошло не так";
  let description = "Мы уже знаем о проблеме. Попробуйте обновить страницу.";
  let status = 500;

  if (isRouteErrorResponse(error)) {
    status = error.status;
    if (error.status === 404) {
      title = "Страница не найдена";
      description = "Возможно, товар снят с продажи или ссылка устарела.";
    } else if (error.status === 403) {
      title = "Доступ закрыт";
      description = "У вас недостаточно прав для просмотра этой страницы.";
    }
  }

  return (
    <main className="container-pulse flex flex-1 flex-col items-center justify-center py-24 text-center">
      <p className="text-sm font-semibold text-pulse-600">{status}</p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">{title}</h1>
      <p className="mt-3 max-w-md text-base text-slate-600">{description}</p>
      <a
        href="/"
        className="mt-8 rounded-lg bg-pulse-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-pulse-700"
      >
        На главную
      </a>
    </main>
  );
}