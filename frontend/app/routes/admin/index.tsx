import { redirect } from "react-router";

import type { Route } from "./+types/index";

import { requireAdminSession } from "~/lib/admin.server";
import { ADMIN_NAV } from "~/lib/admin";

/**
 * `/admin` без раздела: уводим на первый доступный этой роли.
 *
 * Отдельный маршрут, а не `index("routes/admin/orders.tsx")`, потому что
 * index-роут с тем же модулем заставил бы React Router держать две записи об
 * одном файле: переход на `/admin` и на `/admin/orders` стали бы разными
 * маршрутами с двумя одинаковыми loader'ами и двумя одинаковыми компонентами
 * в графе. Здесь — три строки вместо этого дублирования.
 *
 * Роль проверяется здесь же, а не только в layout: index-роут выполняется
 * параллельно с родительским loader'ом, и без собственной проверки он успевает
 * отдать редирект менеджеру, которому `/admin/orders` всё равно закрыт.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const session = await requireAdminSession(request, { roles: ["manager", "admin"] });
  const home = ADMIN_NAV.find((item) => item.roles.includes(session.user.role));

  // Если сессию продлили, обновлённые cookie должны уехать вместе с редиректом:
  // loader не может менять заголовки стороннего ответа, а `throw redirect`
  // отдаёт именно его.
  throw redirect(home?.href ?? "/admin/orders", {
    headers: session.setCookie ?? undefined,
  });
}

export default function AdminIndexRoute() {
  // Достижим только при клиентском переходе без выполнения loader'а
  // (например, prefetch): рендерим заглушку вместо пустой страницы.
  return (
    <p className="text-sm text-slate-600" role="status">
      Открываем раздел админ-панели…
    </p>
  );
}