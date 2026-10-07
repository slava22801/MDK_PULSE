/**
 * Доменная часть админ-панели: типы контракта `/admin/*`, подписи и чистые
 * функции разбора.
 *
 * Модуль изоморфный — его читают и loader'ы/action'ы на сервере, и компоненты
 * в браузере. Поэтому здесь НЕТ `serverFetch` и хуков: только типы, словари и
 * функции без побочных эффектов. Всё, что ходит в API, живёт в
 * `~/lib/admin.server`.
 *
 * Имя файла намеренно без суффикса `.client`: такой суффикс React Router
 * вырезает из серверного бандла, и loader получил бы `undefined`.
 *
 * Контракт снят живыми запросами к стенду (`/openapi.json` + живые вызовы
 * с ролью admin), поэтому денежные поля здесь — строки (на бэке `Decimal`),
 * а форматирует их `formatPrice` из `~/lib/format`.
 */

/* ──────────────────────────────── типы API ──────────────────────────────── */

/**
 * Общая обёртка всех списков `/admin/*`.
 *
 * `AdminListResponse` на backend-е объявлен как `items: any`, поэтому тип
 * `items` задаёт вызывающий: так потеря типизации не расползается дальше.
 */
export type AdminPage<T> = {
  items: T[];
  total: number;
  page: number;
  limit: number;
  pages: number;
};

/** Общая часть `AdminOrderListItem` и `AdminOrderDetail` — это `OrderSummary`. */
export type AdminOrderSummary = {
  id: string;
  order_number: string;
  status: string;
  status_label: string;
  payment_status: string;
  payment_method: string;
  delivery_method: string;
  subtotal: string;
  discount_amount: string;
  delivery_cost: string;
  total_amount: string;
  items_count: number;
  tracking_number: string | null;
  created_at: string;
};

export type AdminOrderListItem = AdminOrderSummary & {
  customer_full_name: string;
  customer_email: string;
  customer_phone: string;
  comment: string | null;
};

/** Пункт заказа в карточке: совпадает с `OrderItemOut` из `~/lib/order`. */
export type AdminOrderItem = {
  id: string;
  product_id: string | null;
  product_name: string;
  sku: string;
  quantity: number;
  price: string;
  total_price: string;
};

export type AdminDeliveryAddress = {
  city: string;
  street: string;
  building: string;
  apartment: string | null;
  postal_code: string | null;
  comment: string | null;
};

export type AdminOrderDetail = AdminOrderSummary & {
  items: AdminOrderItem[];
  customer_first_name: string;
  customer_last_name: string;
  customer_email: string;
  customer_phone: string;
  delivery_address: AdminDeliveryAddress | null;
  pickup_point_id: string | null;
  comment: string | null;
  manager_comment: string | null;
  promo_code: string | null;
  /** Backend сам решает, можно ли отменять заказ: доверяем флагу, не вычисляем. */
  can_cancel: boolean;
};

/** Строка списка товаров админки: урезанный `AdminProductDetail`. */
export type AdminProductListItem = {
  id: string;
  slug: string;
  name: string;
  sku: string | null;
  price: string;
  old_price: string | null;
  purchase_price: string | null;
  stock_quantity: number;
  reserved_quantity: number;
  status: string;
  is_active: boolean;
  category_id: string;
  brand_id: string | null;
  rating_avg: string;
  rating_count: number;
  updated_at: string;
};

export type AdminProductDetail = {
  id: string;
  slug: string;
  name: string;
  sku: string | null;
  model: string | null;
  category_id: string;
  brand_id: string | null;
  short_description: string | null;
  description: string | null;
  price: string;
  old_price: string | null;
  purchase_price: string | null;
  currency: string;
  stock_quantity: number;
  reserved_quantity: number;
  min_stock: number;
  status: string;
  is_active: boolean;
  warranty_months: number;
  weight: string | null;
  width: string | null;
  height: string | null;
  length: string | null;
  rating_avg: string;
  rating_count: number;
  sales_count: number;
  seo_title: string | null;
  seo_description: string | null;
  created_at: string;
  updated_at: string;
};

/** Ответ `GET /admin/products/{id}`: характеристики приходят плоским словарём. */
export type AdminProductResponse = {
  product: AdminProductDetail;
  specs: Record<string, string>;
};

export type AdminUserListItem = {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  role: string;
  is_active: boolean;
  email_verified: boolean;
  blocked_at: string | null;
  created_at: string;
  last_login_at: string | null;
  orders_count: number;
};

export type AdminBrand = {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
};

/**
 * Категория из `GET /admin/categories`.
 *
 * Ответ — дерево: у корневых категорий заполнен `children`, поэтому тип
 * рекурсивный, как и сам ответ (в схеме backend-а это `CategoryRef`).
 */
export type AdminCategoryRef = {
  id: string;
  name: string;
  slug: string;
  level: number;
  parent_id: string | null;
  image_url: string | null;
  children: AdminCategoryRef[];
};

/** Роли пользователя: единственный источник для форм смены роли. */
export const USER_ROLE_VALUES = ["customer", "manager", "admin"] as const;

export type UserRoleValue = (typeof USER_ROLE_VALUES)[number];

export function isUserRole(value: string): value is UserRoleValue {
  return (USER_ROLE_VALUES as readonly string[]).includes(value);
}

export type PromoCodeOut = {
  id: string;
  code: string;
  description: string | null;
  discount_type: string;
  discount_value: string;
  min_order_amount: string;
  max_discount_amount: string | null;
  usage_limit: number | null;
  used_count: number;
  usage_limit_per_user: number | null;
  valid_from: string;
  valid_to: string;
  is_active: boolean;
};

export type PromoCheckResponse = {
  valid: boolean;
  message: string;
  discount_amount: string;
  promo_code: string | null;
};

export type AdminReviewListItem = {
  id: string;
  product_id: string;
  product_name: string;
  user_email: string;
  rating: number;
  title: string;
  text: string;
  status: string;
  is_verified_purchase: boolean;
  created_at: string;
};

export type AdminAuditLogItem = {
  id: string;
  user_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  /** Свободная структура: показываем как есть, без выдуманной схемы. */
  details: unknown;
  ip_address: string | null;
  created_at: string;
};

export type ImportRowError = {
  row_number: number;
  column: string | null;
  message: string;
};

export type ImportReport = {
  total_rows: number;
  created: number;
  updated: number;
  skipped: number;
  errors: ImportRowError[];
  message: string;
};

export type AdminStatistics = {
  revenue_total: string;
  revenue_period: string;
  orders_total: number;
  orders_pending: number;
  orders_completed: number;
  orders_cancelled: number;
  average_order_value: string;
  customers_total: number;
  new_customers_period: number;
  products_total: number;
  products_out_of_stock: number;
  products_low_stock: number;
  reviews_pending: number;
  best_sellers: { id: string; name: string; sku: string | null; sold: number }[];
  low_stock_items: { id: string; name: string; sku: string | null; available: number }[];
  sales_by_day: { date: string; amount: string; orders: number }[];
  period_days: number;
};

/* ──────────────────────────── статусы и роли ───────────────────────────── */

/**
 * Подпись статуса товара. Список взят из `ProductStatus` в OpenAPI backend-а:
 * держать вторую копию — значит однажды показать «Неизвестный статус».
 */
export const PRODUCT_STATUS_LABEL: Record<string, string> = {
  in_stock: "В наличии",
  low_stock: "Осталось мало",
  on_order: "Под заказ",
  expected: "Ожидается",
  out_of_stock: "Нет в наличии",
  discontinued: "Снят с производства",
};

export const PRODUCT_STATUS_VALUES = [
  "in_stock",
  "low_stock",
  "on_order",
  "expected",
  "out_of_stock",
  "discontinued",
] as const;

export type ProductStatus = (typeof PRODUCT_STATUS_VALUES)[number];

export function isProductStatus(value: string): value is ProductStatus {
  return (PRODUCT_STATUS_VALUES as readonly string[]).includes(value);
}

export const REVIEW_STATUS_LABEL: Record<string, string> = {
  pending: "На модерации",
  published: "Опубликован",
  rejected: "Отклонён",
  hidden: "Скрыт",
};

export const REVIEW_STATUS_VALUES = ["pending", "published", "rejected", "hidden"] as const;

export type ReviewStatus = (typeof REVIEW_STATUS_VALUES)[number];

export function isReviewStatus(value: string): value is ReviewStatus {
  return (REVIEW_STATUS_VALUES as readonly string[]).includes(value);
}

export const DISCOUNT_TYPE_LABEL: Record<string, string> = {
  fixed: "Фиксированная сумма",
  percent: "Процент",
  free_delivery: "Бесплатная доставка",
};

export const ROLE_LABEL: Record<string, string> = {
  customer: "Покупатель",
  manager: "Менеджер",
  admin: "Администратор",
};

/* ───────────────────────── разделы и права ролей ───────────────────────── */

/** Идентификатор раздела админки: он же имя маршрута и ключ навигации. */
export type AdminSection =
  | "orders"
  | "products"
  | "users"
  | "promocodes"
  | "reviews"
  | "statistics"
  | "audit-log"
  | "categories";

export type AdminNavItem = {
  section: AdminSection;
  href: string;
  label: string;
  /**
   * Кто видит раздел. Разделение по ТЗ 3.3/3.4: менеджер работает с заказами
   * и статистикой, всё остальное — только администратор.
   *
   * Это правило скрывает пункт меню, но НЕ защищает раздел: та же проверка
   * обязана быть в loader'е (см. `requireAdminSession` в `~/lib/admin.server`).
   */
  roles: readonly string[];
};

/**
 * Навигация админки. Порядок — от ежедневной работы к редкой.
 *
 * `import` намеренно не вынесен в меню отдельной строкой: импорт — это
 * операция над разделом «Товары», поэтому он живёт на странице товаров
 * как отдельная форма, иначе меню разрастается до девяти пунктов.
 */
export const ADMIN_NAV: readonly AdminNavItem[] = [
  { section: "orders", href: "/admin/orders", label: "Заказы", roles: ["manager", "admin"] },
  { section: "products", href: "/admin/products", label: "Товары", roles: ["admin"] },
  { section: "categories", href: "/admin/categories", label: "Категории и бренды", roles: ["admin"] },
  { section: "users", href: "/admin/users", label: "Пользователи", roles: ["admin"] },
  // Промокоды в меню есть у обеих ролей: CRUD только администраторское, но
  // проверка кода на сумме сервер разрешает и менеджеру (живая проверка), и
  // менять пункт по ролям здесь означало бы спрятать от менеджера доступную ему
  // возможность. Права внутри страницы разводит её loader.
  { section: "promocodes", href: "/admin/promocodes", label: "Промокоды", roles: ["manager", "admin"] },
  { section: "reviews", href: "/admin/reviews", label: "Отзывы", roles: ["admin"] },
  { section: "statistics", href: "/admin/statistics", label: "Статистика", roles: ["manager", "admin"] },
  { section: "audit-log", href: "/admin/audit-log", label: "Журнал действий", roles: ["admin"] },
];

/** Раздел показывается только перечисленным ролям. */
export function canAccessSection(role: string, section: AdminSection): boolean {
  const item = ADMIN_NAV.find((entry) => entry.section === section);
  return item ? item.roles.includes(role) : false;
}

/** Доступна ли роль хоть одному разделу админки (иначе — уводим с витрины). */
export function isStaffRole(role: string): boolean {
  return role === "manager" || role === "admin";
}

/* ─────────────────────── переходы статуса заказа ───────────────────────── */

/**
 * Разрешённые переходы берём ОТ СЕРВЕРА, а не из своей таблицы.
 *
 * Живой проверкой видно, что backend отдаёт их в `fields.allowed` при 409
 * `invalid_status_transition` — строкой «confirmed, awaiting_payment, cancelled».
 * Это единственный источник истины: своя таблица переходов мгновенно разошлась
 * бы с бизнес-правилами (с отменённого заказа возврат разрешён, а с
 * возвращённого — ничего), и менеджер видел бы неработающие кнопки.
 *
 * @param raw значение `fields.allowed`; пустая строка означает «переходов нет»
 *            (например, заказ в финальном статусе `refunded`).
 */
export function parseAllowedTransitions(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Код `invalid_status_transition` — единственный, у которого важен `fields.allowed`. */
export function isInvalidTransition(code: string): boolean {
  return code === "invalid_status_transition";
}

/* ─────────────────────────── разбор query-строки ────────────────────────── */

/** Страница из query: мусор и отрицательные значения откатываем к 1. */
export function parsePage(raw: string | null, fallback = 1): number {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Размер страницы: backend ограничивает 100, поэтому и мы просим не больше. */
export function parseLimit(raw: string | null, fallback = 25): number {
  const value = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(value, 100);
}

/** `?flag=true|false` → boolean | null; пустое значение означает «фильтр не задан». */
export function parseBoolParam(raw: string | null): boolean | null {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

/** Статус заказа из фильтра: пустая строка — «все статусы». */
export function parseStatusFilter(raw: string | null): string {
  return (raw ?? "").trim();
}

/**
 * Ссылка на страницу пагинации с теми же фильтрами.
 *
 * Общая копия `pageHref` из `~/lib/catalog`: та привязана к каталогу по
 * смыслу, а админке нужен свой, чтобы не тянуть в админку зависимость от
 * каталожных типов.
 */
export function adminPageHref(pathname: string, source: URLSearchParams, page: number): string {
  const next = new URLSearchParams(source);
  if (page <= 1) next.delete("page");
  else next.set("page", String(page));
  const query = next.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/* ────────────────────────────── форматирование ──────────────────────────── */

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("ru-RU");
}

/** `<input type="datetime-local">` понимает только `YYYY-MM-DDTHH:mm`. */
export function toDateTimeLocal(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** `datetime-local` → ISO со смещением, которое понимает backend (date-time). */
export function fromDateTimeLocal(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}