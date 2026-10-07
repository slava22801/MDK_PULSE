/**
 * Контракт личного кабинета: адреса и заказы.
 *
 * Профиль намеренно здесь не описан: его поля полностью совпадают с `UserOut`
 * из `~/lib/auth`, а `/auth/me` отвечает всегда, тогда как `/me` может быть
 * недоступен. Поэтому профиль читаем из `/auth/me`, а правим через `PATCH /me`
 * (см. `app/routes/account.tsx`).
 *
 * Денежные поля — строки: на backend-е это `Decimal`, форматирует их
 * `formatPrice` из `~/lib/format`.
 */

export type AddressOut = {
  id: string;
  /** Короткая метка вроде «Дом» или «Работа» — может отсутствовать. */
  label: string | null;
  recipient_name: string;
  phone: string;
  city: string;
  street: string;
  building: string;
  apartment: string | null;
  postal_code: string | null;
  country: string;
  comment: string | null;
  is_default: boolean;
};

export type OrderSummary = {
  id: string;
  order_number: string;
  status: string;
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

export type OrderListResponse = {
  items: OrderSummary[];
  total: number;
  page: number;
  limit: number;
  pages: number;
};