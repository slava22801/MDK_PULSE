/**
 * Контракт оформления и заказов — общий для чекаута, страницы оплаты,
 * страницы заказа и кабинета.
 *
 * Типы сняты живыми запросами к стенду (`GET /openapi.json` плюс реальные
 * вызовы), поэтому здесь ровно то, что backend отдаёт на самом деле:
 *  - денежные поля приходят строками (на бэке это `Decimal`), форматирует их
 *    `formatPrice` из `~/lib/format`;
 *  - `delivery_method` и `payment_method` — закрытые перечисления, а не
 *    произвольные строки, поэтому значения зафиксированы как `as const` и
 *    проверяются функциями-guard'ами: мусор в форме не должен попасть в тело
 *    запроса и не должен ломать типизацию.
 *
 * Модуль изоморфный (как `~/lib/cart` и `~/lib/catalog`): его читают и
 * loader'ы на сервере, и компоненты в браузере. Ни `serverFetch`, ни хуков
 * здесь быть не должно.
 */

/* ───────────────────────── способы доставки и оплаты ─────────────────────── */

export const DELIVERY_METHODS = [
  "courier",
  "pickup",
  "pickup_point",
  "transport_company",
] as const;

export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];

export const PAYMENT_METHODS = ["card", "online", "cash_on_delivery", "invoice"] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * Значение из формы — строка, а не `DeliveryMethod`.
 *
 * Браузер и злонамеренный клиент присылают что угодно, поэтому сужаем тип
 * проверкой по списку, а не приведением: иначе `delivery_method: "hash"`
 * дошёл бы до backend и вернул 422 без понятного сообщения.
 */
export function isDeliveryMethod(value: string): value is DeliveryMethod {
  return (DELIVERY_METHODS as readonly string[]).includes(value);
}

export function isPaymentMethod(value: string): value is PaymentMethod {
  return (PAYMENT_METHODS as readonly string[]).includes(value);
}

export type MethodOption<T extends string> = {
  value: T;
  label: string;
  hint: string;
};

/**
 * Подписи способов доставки и оплаты с пояснением — в форме это содержимое
 * `<legend>` и подпись под переключателем, потому что «карта» и «онлайн» без
 * расшифровки означают для покупателя одно и то же.
 */
export const DELIVERY_OPTIONS: readonly MethodOption<DeliveryMethod>[] = [
  {
    value: "courier",
    label: "Курьером по городу",
    hint: "Доставим до двери, 590 ₽. Нужен полный адрес.",
  },
  {
    value: "pickup",
    label: "Самовывоз из магазина",
    hint: "Без доставки и без наценки. Адрес указывать не нужно.",
  },
  {
    value: "pickup_point",
    label: "Пункт выдачи",
    hint: "Стоимость доставки 0 ₽. Конкретный пункт подтвердит менеджер по телефону.",
  },
  {
    value: "transport_company",
    label: "Транспортная компания",
    hint: "890 ₽ до терминала ТК. Нужен полный адрес.",
  },
];

export const PAYMENT_OPTIONS: readonly MethodOption<PaymentMethod>[] = [
  {
    value: "card",
    label: "Банковской картой",
    hint: "Оплата сразу после оформления заказа.",
  },
  {
    value: "online",
    label: "Онлайн-оплата",
    hint: "Оплата через интернет-банк или СБП.",
  },
  {
    value: "cash_on_delivery",
    label: "При получении",
    hint: "Наличными или картой курьеру при передаче заказа.",
  },
  {
    value: "invoice",
    label: "Счёт для организации",
    hint: "Выставим счёт на 300 ₽, по нему ждём оплату.",
  },
];

export const DELIVERY_METHOD_LABEL: Record<DeliveryMethod, string> = {
  courier: "Курьер",
  pickup: "Самовывоз",
  pickup_point: "Пункт выдачи",
  transport_company: "Транспортная компания",
};

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  card: "Банковская карта",
  online: "Онлайн-оплата",
  cash_on_delivery: "При получении",
  invoice: "Счёт для организации",
};

/** Подпись для произвольной строки ответа: неизвестный код показываем как есть. */
export function deliveryMethodLabel(value: string): string {
  return isDeliveryMethod(value) ? DELIVERY_METHOD_LABEL[value] : value;
}

export function paymentMethodLabel(value: string): string {
  return isPaymentMethod(value) ? PAYMENT_METHOD_LABEL[value] : value;
}

/**
 * Нужен ли адрес доставки.
 *
 * Проверено живым запросом: `POST /orders` с `delivery_method=courier` без
 * адреса отвечает 422 `validation_error` с `fields._root` = «Для доставки
 * курьером нужен адрес». Самовывоз и пункт выдачи адреса не требуют.
 */
export function needsDeliveryAddress(method: DeliveryMethod): boolean {
  return method === "courier" || method === "transport_company";
}

/* ─────────────────────────────── статусы ────────────────────────────────── */

/**
 * Одиннадцать статусов раздела 5.10 ТЗ.
 *
 * `GET /me/orders` подпись статуса не отдаёт (в схеме `account::OrderSummary`
 * её нет), поэтому подписи держим на фронте. `OrderOut.status_label` при этом
 * приходит — его подставит `orderStatusLabel`, чтобы текст совпадал с бэком.
 */
export const ORDER_STATUS_LABEL: Record<string, string> = {
  new: "Новый",
  confirmed: "Подтверждён",
  awaiting_payment: "Ожидает оплаты",
  paid: "Оплачен",
  assembling: "Собирается",
  shipped: "Передан в доставку",
  ready_for_pickup: "Готов к выдаче",
  completed: "Выполнен",
  cancelled: "Отменён",
  return_requested: "Возврат",
  refunded: "Возвращён",
};

export const ORDER_STATUS_TONE: Record<string, string> = {
  new: "bg-slate-100 text-slate-700",
  confirmed: "bg-sky-100 text-sky-800",
  awaiting_payment: "bg-amber-100 text-amber-800",
  paid: "bg-emerald-100 text-emerald-800",
  assembling: "bg-violet-100 text-violet-800",
  shipped: "bg-violet-100 text-violet-800",
  ready_for_pickup: "bg-emerald-100 text-emerald-800",
  completed: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-rose-100 text-rose-700",
  return_requested: "bg-amber-100 text-amber-800",
  refunded: "bg-slate-200 text-slate-700",
};

/** Подпись статуса: сначала версия backend-а, потом наш словарь. */
export function orderStatusLabel(status: string, backendLabel?: string | null): string {
  if (backendLabel) return backendLabel;
  return ORDER_STATUS_LABEL[status] ?? status;
}

export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  pending: "Ожидает оплаты",
  awaiting: "Ожидает оплаты",
  paid: "Оплачен",
  failed: "Ошибка оплаты",
  refunded: "Возвращён",
  cancelled: "Отменена",
};

export function paymentStatusLabel(value: string): string {
  return PAYMENT_STATUS_LABEL[value] ?? value;
}

/* ────────────────────────────── контракт API ────────────────────────────── */

export type OrderItemOut = {
  id: string;
  /** В предпросмотре backend не проставляет `product_id` — там он `null`. */
  product_id: string | null;
  product_name: string;
  sku: string;
  quantity: number;
  price: string;
  total_price: string;
};

/** Адрес в ответе `OrderOut`: та же структура, что и во входном `DeliveryAddress`. */
export type DeliveryAddressOut = {
  city: string;
  street: string;
  building: string;
  apartment: string | null;
  postal_code: string | null;
  comment: string | null;
};

export type OrderOut = {
  id: string;
  order_number: string;
  status: string;
  status_label: string;
  payment_status: string;
  payment_method: PaymentMethod | string;
  delivery_method: DeliveryMethod | string;
  subtotal: string;
  discount_amount: string;
  delivery_cost: string;
  total_amount: string;
  items_count: number;
  tracking_number: string | null;
  created_at: string;
  items: OrderItemOut[];
  promo_code: string | null;
  currency: string;
  customer_first_name: string;
  customer_last_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  delivery_address: DeliveryAddressOut | null;
  comment: string | null;
  manager_comment: string | null;
  can_cancel: boolean;
};

/** Ответ `POST /checkout/preview` — итог считает сервер, браузер не считает. */
export type CheckoutPreview = {
  items_count: number;
  items: OrderItemOut[];
  subtotal: string;
  discount_amount: string;
  delivery_cost: string;
  total: string;
  currency: string;
  promo_code: string | null;
  /** Замечания расчёта: «промокод не применён: …», минимальная сумма и т. п. */
  notes: string[];
  /** Непустой массив означает, что оформление невозможно (ТЗ 5.9, шаг 1). */
  unavailable: string[];
};

/**
 * Тело `POST /orders`.
 *
 * Сумм здесь нет намеренно: раздел 22 ТЗ требует, чтобы цену считал сервер,
 * поэтому клиент не присылает ни цены, ни количества в рублях — только
 * контакты, способы и адрес.
 */
export type OrderCreatePayload = {
  customer_first_name: string;
  customer_last_name: string;
  customer_email: string;
  customer_phone: string;
  delivery_method: DeliveryMethod;
  payment_method: PaymentMethod;
  delivery_address: {
    city: string;
    street: string;
    building: string;
    apartment?: string | null;
    postal_code?: string | null;
    comment?: string | null;
  } | null;
  pickup_point_id: string | null;
  comment?: string | null;
  promo_code?: string | null;
};

/** Ответ `POST /orders/{id}/payment` от фейкового провайдера. */
export type PaymentStartResponse = {
  provider: string;
  external_id: string;
  amount: string;
  status: string;
  /** Готовый адрес страницы подтверждения: `/payment/{id}?token=…`. */
  redirect_url: string | null;
  confirmation_token: string | null;
};

export type MessageResponse = {
  message: string;
};

/** Форматирует адрес заказа в одну строку; `null` для самовывоза. */
export function addressLine(address: DeliveryAddressOut | null): string {
  if (!address) return "";
  return [
    address.city,
    address.street,
    `д. ${address.building}`,
    address.apartment ? `кв. ${address.apartment}` : null,
    address.postal_code,
  ]
    .filter(Boolean)
    .join(", ");
}