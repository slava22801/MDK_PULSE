/**
 * Контракт корзины и помощники, общие для гостя и авторизованного покупателя.
 *
 * Модуль намеренно изоморфный (как `~/lib/catalog` и `~/lib/auth`): его читают и
 * loader'ы на сервере, и стор в браузере. Здесь нет ни `serverFetch`, ни хуков —
 * только типы и чистые функции, поэтому импорт безопасен в обоих бандлах.
 *
 * Денежные поля — строки: на backend-е это `Decimal`, во float его превращать
 * нельзя. Форматирует их `formatPrice` из `~/lib/format`.
 */
import type { Availability, CategoryNode } from "./catalog";

/**
 * Категория позиции приходит тем же объектом, что и в карточке товара
 * (проверено живым запросом), поэтому переиспользуем `CategoryNode`, а не
 * заводим второй почти такой же тип.
 */

export type CartTotals = {
  items_count: number;
  subtotal: string;
  discount_amount: string;
  delivery_cost: string;
  total: string;
  currency: string;
};

/**
 * Уведомление о позиции, которую пришлось урезать.
 *
 * Требование ТЗ 5.8: показать пользователю, сколько товара на самом деле
 * доступно, — молча уменьшать количество нельзя.
 */
export type CartNotice = {
  product_id: string;
  product_name: string;
  /** Сколько просил пользователь. */
  requested: number;
  /** Сколько есть на складе (или сколько добавили в итоге). */
  available: number;
  code: string;
  message: string;
};

export type CartItem = {
  id: string;
  product_id: string;
  quantity: number;
  product_name: string;
  product_slug: string;
  sku: string | null;
  brand_name: string | null;
  category: CategoryNode;
  image_url: string | null;
  image_alt: string | null;
  unit_price: string;
  old_price: string | null;
  discount_percent: number;
  currency: string;
  line_total: string;
  availability: Availability;
  available_quantity: number;
  /** Количество больше остатка на складе — заказ оформлять нельзя. */
  exceeds_stock: boolean;
  added_at: string;
};

export type Cart = {
  items: CartItem[];
  totals: CartTotals;
  unavailable_count: number;
  notices: CartNotice[];
};

/**
 * Границы количества одной позиции.
 *
 * Проверено живым запросом к backend-у: `UpdateCartItemRequest.quantity`
 * ограничено `ge=1, le=99`, поэтому поле ввода и кнопки ± держим в тех же
 * границах — иначе пользователь получает 422 вместо изменения корзины.
 */
export const MIN_CART_QUANTITY = 1;
export const MAX_CART_QUANTITY = 99;

export function emptyCart(): Cart {
  return {
    items: [],
    totals: {
      items_count: 0,
      subtotal: "0",
      discount_amount: "0",
      delivery_cost: "0",
      total: "0",
      currency: "RUB",
    },
    unavailable_count: 0,
    notices: [],
  };
}

/** Позиции, из-за которых нельзя оформить заказ (ТЗ 5.8). */
export function cartBlockingItems(cart: Cart): CartItem[] {
  return cart.items.filter((item) => item.exceeds_stock);
}

/* ───────────────────────── гостевой идентификатор ───────────────────────── */

/**
 * Cookie гостевой корзины ставит backend сам (`pulse_cart` в deps.py).
 *
 * Пробрасывать её вручную не нужно — браузер делает это сам при
 * `credentials: "same-origin"`. Но `serverFetch` идёт из Node, где cookie
 * браузера не существует, поэтому SSR-loader обязан переслать заголовок сам,
 * иначе гость увидел бы пустую корзину до первого клика по «Обновить».
 */
export const GUEST_CART_COOKIE = "pulse_cart";

/** Имя access-токена из `~/lib/auth-token` — нужно для пересылки при SSR. */
const ACCESS_COOKIE = "pulse_at";

/**
 * Только эти cookie уходят на backend.
 *
 * Весь заголовок `Cookie` пробрасывать нельзя: кроме них там лежат cookie
 * самой инфраструктуры стенда, и их передача в API — лишнее раскрытие.
 */
const FORWARDED_COOKIES: readonly string[] = [GUEST_CART_COOKIE, ACCESS_COOKIE];

export function forwardCookies(request: Request): Record<string, string> {
  const raw = request.headers.get("Cookie");
  if (!raw) return {};

  const pairs: string[] = [];
  for (const part of raw.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (!name || rest.length === 0) continue;
    if (!FORWARDED_COOKIES.includes(name)) continue;
    pairs.push(`${name}=${rest.join("=")}`);
  }

  // Собирать надо ОДИН заголовок Cookie, а не отдельные заголовки с именами
  // cookie: `headers: { pulse_cart: "..."}` отправляет в API безымянный
  // заголовок, и backend не видит ни одной cookie — SSR показывал пустую корзину.
  return pairs.length > 0 ? { Cookie: pairs.join("; ") } : {};
}

/**
 * Заголовки SSR-запроса к backend: cookie гостевой корзины плюс Bearer,
 * если сессия есть. Без них гость получил бы пустую корзину, а
 * авторизованный — чужую (или вовсе никакую).
 */
export function cartRequestHeaders(request: Request, token?: string | null): Record<string, string> {
  const headers = forwardCookies(request);
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}