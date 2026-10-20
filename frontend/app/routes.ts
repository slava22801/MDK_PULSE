import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  // Каталог: общий список и страница категории делят один виджет фильтров,
  // поэтому slug-вариант идёт сразу за /catalog.
  route("catalog", "routes/catalog.tsx"),
  route("catalog/:slug", "routes/category.tsx"),
  route("product/:slug", "routes/product.tsx"),
  route("login", "routes/login.tsx"),
  route("register", "routes/register.tsx"),
  // Корзина доступна и гостю, поэтому идёт до /account: гостю нужен путь
  // в магазин без регистрации.
  route("cart", "routes/cart.tsx"),
  // Оформление и заказ. Отдельный `payment/:orderId` — это адрес, который
  // выдаёт платёжный провайдер в `redirect_url`, поэтому он задаётся
  // буквально тем путём, который backend вернёт.
  route("checkout", "routes/checkout.tsx"),
  route("order/:orderId", "routes/order.tsx"),
  route("payment/:orderId", "routes/payment.tsx"),
  route("favorites", "routes/favorites.tsx"),
  route("compare", "routes/compare.tsx"),
  route("account", "routes/account.tsx"),
  // Админка — отдельная оболочка с навигацией по разделам и проверкой роли в
  // loader'е. Вложенные маршруты React Router грузит отдельными чанками, поэтому
  // таблицы админки не попадают в бандл витрины (главная и каталог остаются
  // лёгкими для первой загрузки).
  route("admin", "routes/admin/layout.tsx", [
    route("orders", "routes/admin/orders.tsx"),
    // Остатки открыты менеджеру: пересчёт количества — его ежедневная работа.
    route("stock", "routes/admin/stock.tsx"),
    route("products", "routes/admin/products.tsx"),
    route("import", "routes/admin/import.tsx"),
    route("categories", "routes/admin/categories.tsx"),
    route("users", "routes/admin/users.tsx"),
    route("promocodes", "routes/admin/promocodes.tsx"),
    route("reviews", "routes/admin/reviews.tsx"),
    route("statistics", "routes/admin/statistics.tsx"),
    route("audit-log", "routes/admin/audit-log.tsx"),
    // `/admin` без раздела редиректит на первый доступный роль (см. index.tsx):
    // index с модулем заказов продублировал бы записи одного файла в графе.
    index("routes/admin/index.tsx"),
  ]),
  // Ресурсный роут выхода: принимает POST, GET перенаправляет на главную.
  route("logout", "routes/logout.ts"),
  // Служебный ресурсный роут для Docker healthcheck, без обращений к backend.
  route("healthz", "routes/healthz.ts"),
] satisfies RouteConfig;