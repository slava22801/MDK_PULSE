import { useEffect } from "react";
import { data, Form, Outlet, useLocation, useNavigation } from "react-router";

import type { Route } from "./+types/layout";

import type { UserOut } from "~/lib/auth";
import { requireAdminSession } from "~/lib/admin.server";
import { ADMIN_NAV, ROLE_LABEL } from "~/lib/admin";
import { useAuthStore } from "~/stores/auth";

export function meta(): Route.MetaDescriptors {
  return [
    { title: "Админ-панель — ПУЛЬС" },
    // Раздел служебный: в индекс он попадать не должен.
    { name: "robots", content: "noindex, nofollow" },
  ];
}

/**
 * Оболочка админки: проверка роли, навигация по разделам, выход.
 *
 * Проверка роли стоит в loader'е, а не в компоненте, потому что все дочерние
 * loader'ы React Router запускает ПАРАЛЛЕЛЬНО с родительским — компонент с
 * проверкой отрисовался бы на долю секунды раньше, чем придёт ответ.
 *
 * По той же причине раздел закрыт и в loader'е дочернего роута
 * (`requireAdminSession(..., { section })`): навигация скрывает пункт, но
 * адрес /admin/products менеджеру всё равно доступен.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const session = await requireAdminSession(request, { roles: ["manager", "admin"] });

  // Разделы, доступные этой роли. Для менеджера это заказы и статистика.
  const sections = ADMIN_NAV.filter((item) => item.roles.includes(session.user.role));

  const payload = {
    user: session.user,
    sections,
    /** Первая страница раздела: нужна для ссылки «Начать с…» у клиента. */
    home: sections[0]?.href ?? "/admin/orders",
  };

  // Обновлённые cookie после продления сессии едут в ответе этого роута —
  // он обрамляет все разделы админки, поэтому refresh всегда будет отдан
  // браузеру, даже когда токен обновился на дочернем разделе.
  if (session.setCookie) {
    return data(payload, { headers: session.setCookie });
  }
  return payload;
}

export default function AdminLayout({ loaderData }: Route.ComponentProps) {
  const navigation = useNavigation();
  // Путь берём из location, а не из `window`: разметка активного пункта должна
  // совпадать на сервере и в браузере, иначе гидрация ломает `aria-current`.
  const pathname = useLocation().pathname;

  // Профиль из loader'а — единственный источник роли на сервере; кладём его в
  // стор, чтобы шапка магазина (на других маршрутах) знала имя сотрудника.
  const user = loaderData.user;

  // Полоска загрузки нужна только при переходах между разделами: без неё
  // страница с таблицей мигает белым на каждом клике по меню.
  const busy = navigation.state !== "idle";

  return (
    <div className="flex min-h-full flex-col bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
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

          <span className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-bold tracking-wide text-slate-600 uppercase">
            Админ
          </span>

          <div className="ms-auto flex items-center gap-2">
            <a
              href="/account"
              className="hidden rounded-lg px-2.5 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 sm:inline"
            >
              Витрина магазина
            </a>
            <span className="hidden text-sm text-slate-600 sm:inline">
              {user.first_name || user.email}
              <span className="ml-1.5 text-slate-400">({ROLE_LABEL[user.role] ?? user.role})</span>
            </span>
            <AdminLogout />
          </div>
        </div>
      </header>

      <div className="container-pulse flex flex-1 flex-col gap-6 py-6 lg:flex-row lg:gap-8">
        {/*
          Навигация разделам. Ссылка обычная, а не `<Link>`: дочерние loader'ы
          ходят в backend через `serverFetch`, который в браузере смотрит на
          `API_INTERNAL_URL` и уводит запрос не туда. Полная перезагрузка
          гарантирует выполнение loader'а на сервере — так же, как в SiteHeader.
        */}
        <nav
          aria-label="Разделы админ-панели"
          className="lg:w-60 lg:shrink-0"
        >
          <ul className="flex gap-1 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible lg:pb-0">
            {loaderData.sections.map((item) => (
              <li key={item.section} className="shrink-0">
                <a
                  href={item.href}
                  aria-current={isCurrentPath(pathname, item.href) ? "page" : undefined}
                  className="block rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap text-slate-700 transition-colors hover:bg-slate-100 aria-[current=page]:bg-pulse-600 aria-[current=page]:text-white"
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <main id="admin-content" className="min-w-0 flex-1">
          {busy ? (
            <div className="sr-only" role="status">
              Загружаем раздел…
            </div>
          ) : null}
          {/*
            Вложенный раздел рендерится через `<Outlet>`: так layout остаётся
            оболочкой, а не компонентом с `children`, который пришлось бы передавать
            вручную в каждом маршруте.
          */}
          <Outlet />
        </main>
      </div>

      <StaffUserSync user={user} />
    </div>
  );
}

/**
 * Синхронизация профиля сотрудника со стором.
 *
 * Отдельная компонент-обёртка, потому что `useEffect` нельзя вызывать условно:
 * без неё правило хуков сработало бы в момент, когда loader отдаст другую роль.
 *
 * Обновляем стор только при реальном изменении профиля: `setUser` пишет в
 * localStorage, и писать его на каждом рендере незачем.
 */
function StaffUserSync({ user }: { user: UserOut }) {
  const setUser = useAuthStore((state) => state.setUser);
  const key = `${user.id}:${user.role}:${user.email}`;

  useEffect(() => {
    if (useAuthStore.getState().user?.id === user.id && useAuthStore.getState().user?.role === user.role) {
      return;
    }
    setUser(user);
    // `key` вместо `user`: сравнение по идентичности объекта обновляло бы стор
    // на каждом рендере, потому что loader каждый раз отдаёт новый объект.
  }, [key, setUser, user]);
  return null;
}

/**
 * Выход.
 *
 * Форма шлёт POST на существующий ресурсный роут `/logout` — это работает без
 * JavaScript, а кликовый обработчик ниже лишь убирает ожидание: серверный
 * logout отозвал бы refresh-токен, но стор в памяти остался бы заполнен.
 */
function AdminLogout() {
  const logout = useAuthStore((state) => state.logout);
  return (
    <Form
      method="post"
      action="/logout"
      onSubmit={(event) => {
        event.preventDefault();
        void logout().finally(() => {
          window.location.assign("/");
        });
      }}
    >
      <button
        type="submit"
        className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
      >
        Выйти
      </button>
    </Form>
  );
}

/** Ссылка текущего раздела помечается `aria-current`, иначе навигация слепнет для скринридера. */
function isCurrentPath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
