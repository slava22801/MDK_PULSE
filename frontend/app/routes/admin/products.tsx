import { data, Form, useActionData, useNavigation, useSearchParams } from "react-router";

import type { Route } from "./+types/products";

import type {
  AdminBrand,
  AdminCategoryRef,
  AdminPage,
  AdminProductDetail,
  AdminProductListItem,
  AdminProductResponse,
} from "~/lib/admin";
import type { ApiErrorInfo } from "~/lib/api-error";
import { describeApiError } from "~/lib/api-error";
import { serverFetch } from "~/lib/api.server";
import { queryString, requireAdminSession } from "~/lib/admin.server";
import {
  PRODUCT_STATUS_LABEL,
  PRODUCT_STATUS_VALUES,
  formatDateTime,
  parseBoolParam,
  parseLimit,
  parsePage,
} from "~/lib/admin";
import { formatPrice } from "~/lib/format";
import {
  ADMIN_INPUT,
  ActionButton,
  AdminCell,
  AdminField,
  AdminNotice,
  AdminPageHeader,
  AdminPagination,
  AdminTable,
  AdminTextarea,
  DateCell,
  EmptyState,
  FilterBar,
  FilterField,
  LoadError,
  MoneyCell,
  StatusBadge,
  statusTone,
} from "~/widgets/admin-ui";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Товары — Админ-панель — ПУЛЬС" }];
}

/**
 * Товары: список, карточка редактирования, изменение остатка, удаление.
 *
 * Раздел только для администратора — проверка роли в `requireAdminSession`
 * (ТЗ 3.4). Справочники категорий и брендов нужны обеим формам (создания и
 * правки), поэтому грузятся вместе со списком одним параллельным заходом.
 *
 * Создание и правка живут на одной странице: `?edit=<id>` открывает форму
 * товара, `?new=1` — пустую. Отдельные маршруты заставили бы дублировать
 * форму целиком, а различие только в значениях по умолчанию.
 */

type ProductFilters = {
  search: string;
  categoryId: string;
  brandId: string;
  status: string;
  inStock: boolean | null;
  page: number;
  limit: number;
};

function readFilters(url: URL): ProductFilters {
  return {
    search: (url.searchParams.get("search") ?? "").trim(),
    categoryId: (url.searchParams.get("category_id") ?? "").trim(),
    brandId: (url.searchParams.get("brand_id") ?? "").trim(),
    status: (url.searchParams.get("status") ?? "").trim(),
    inStock: parseBoolParam(url.searchParams.get("in_stock")),
    page: parsePage(url.searchParams.get("page")),
    limit: parseLimit(url.searchParams.get("limit")),
  };
}

/** Ответ action'а: сообщение плюс серверные ошибки по конкретным полям. */
type ProductActionResult = {
  ok?: string;
  error?: string;
  errorCode?: string;
  fields?: Record<string, string>;
  /** Возвращаем `edit`, чтобы форма не потеряла товар после неудачи. */
  edit?: string;
};

export async function loader({ request }: Route.LoaderArgs) {
  const session = await requireAdminSession(request, { section: "products" });
  const url = new URL(request.url);
  const filters = readFilters(url);
  const editId = url.searchParams.get("edit");
  const creating = url.searchParams.get("new") === "1";

  const [list, categories, brands, detail] = await Promise.all([
    serverFetch<AdminPage<AdminProductListItem>>(
      `/admin/products${queryString({
        page: filters.page,
        limit: filters.limit,
        search: filters.search,
        category_id: filters.categoryId,
        brand_id: filters.brandId,
        status: filters.status,
        // `null` — фильтр не задан; иначе строка, потому что queryString
        // принимает только строки и числа, а backend ждёт `true | false`.
        in_stock: filters.inStock === null ? null : String(filters.inStock),
      })}`,
      { headers: session.headers },
    ).catch((cause: unknown) => cause as ApiErrorInfo),

    // Справочники не критичны для списка: без них фильтр по категории не
    // отрисуется, но товары покажутся. Поэтому ошибку не поднимаем.
    serverFetch<{ items: AdminCategoryRef[] }>("/admin/categories", { headers: session.headers }).catch(
      () => ({ items: [] }),
    ),
    serverFetch<{ items: AdminBrand[] }>("/admin/brands", { headers: session.headers }).catch(() => ({
      items: [],
    })),
    editId
      ? serverFetch<AdminProductResponse>(`/admin/products/${encodeURIComponent(editId)}`, {
          headers: session.headers,
        }).catch((cause: unknown) => cause as ApiErrorInfo)
      : Promise.resolve(null),
  ]);

  const listError = list instanceof Error ? describeApiError(list, "Не удалось загрузить товары") : null;
  const detailError =
    detail instanceof Error ? describeApiError(detail, "Не удалось загрузить товар") : null;

  return {
    filters,
    products: listError ? null : (list as AdminPage<AdminProductListItem>),
    listError,
    categories: categories.items,
    brands: brands.items,
    /**
     * Товар для правки либо пустая форма создания.
     *
     * `detail` равен null, когда ни создание, ни правка не запрошены —
     * читать `.product` у null и приводило к падению страницы.
     */
    editing: creating || !detail
      ? { mode: "create" as const, product: null, specs: {} }
      : detailError
        ? null
        : {
            mode: "edit" as const,
            product: (detail as AdminProductResponse).product,
            specs: (detail as AdminProductResponse).specs,
          },
    detailError,
  };
}

/** Тело формы → `ProductCreate`/`ProductUpdate`: пустые строки не отправляем. */
type ProductForm = {
  name: string;
  slug: string;
  sku: string;
  category_id: string;
  brand_id: string;
  price: string;
  old_price: string;
  purchase_price: string;
  stock_quantity: string;
  min_stock: string;
  status: string;
  warranty_months: string;
  short_description: string;
  description: string;
  is_active: boolean;
  specs: Record<string, string>;
};

/**
 * Читает форму товара.
 *
 * Числовые поля приходят строками и уходят на backend строками же: его схема
 * допускает `number | str` (Decimal), и так не теряется точность. Пустые
 * значения отбрасываются — иначе PATCH затёр бы поле пустой строкой, а не
 * «оставь как есть».
 */
function readProductForm(form: FormData): ProductForm {
  const field = (name: string): string => String(form.get(name) ?? "").trim();
  const specs: Record<string, string> = {};

  // Характеристики приходят парами `spec_key_N` / `spec_value_N` — такой
  // формат работает без JS: динамические списки на голом HTML не собрать.
  form.forEach((value, rawKey) => {
    if (!rawKey.startsWith("spec_key_")) return;
    const key = String(value).trim();
    if (!key) return;
    const value2 = String(form.get(`spec_value_${rawKey.slice("spec_key_".length)}`) ?? "").trim();
    if (value2) specs[key] = value2;
  });

  return {
    name: field("name"),
    slug: field("slug"),
    sku: field("sku"),
    category_id: field("category_id"),
    brand_id: field("brand_id"),
    price: field("price"),
    old_price: field("old_price"),
    purchase_price: field("purchase_price"),
    stock_quantity: field("stock_quantity"),
    min_stock: field("min_stock"),
    status: field("status"),
    warranty_months: field("warranty_months"),
    short_description: field("short_description"),
    description: field("description"),
    // Снятый чекбокс не присылает значение — значит «товар скрыт с витрины».
    is_active: form.get("is_active") !== null,
    specs,
  };
}

/**
 * Собирает JSON-тело, выбрасывая пустые опциональные поля.
 *
 * Разница между созданием и правкой — в двух местах:
 *  - характеристики при PATCH всегда уходят (backend применяет их с
 *    `replace=True`), иначе нельзя было бы удалить лишнюю пару;
 *  - пустая старая цена при PATCH уходит как `null`, то есть снимает скидку.
 *    При создании пустые значения просто не отправляются.
 */
function productPayload(form: ProductForm, editing: boolean): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: form.name,
    sku: form.sku,
    category_id: form.category_id,
    price: Number(form.price),
    status: form.status || "in_stock",
    is_active: form.is_active,
  };

  // Текстовые поля уходят строками как есть…
  const texts: Record<string, string> = {
    slug: form.slug,
    short_description: form.short_description,
    description: form.description,
  };
  for (const [key, value] of Object.entries(texts)) {
    if (value !== "") payload[key] = value;
  }

  if (form.brand_id !== "") payload.brand_id = form.brand_id;

  // …а числовые — числами: его схема принимает `number | str` (Decimal), и
  // строка «21990,00» с запятой пришла бы ошибкой валидации.
  const numbers: Record<string, string> = {
    purchase_price: form.purchase_price,
    stock_quantity: form.stock_quantity,
    min_stock: form.min_stock,
    warranty_months: form.warranty_months,
  };
  for (const [key, value] of Object.entries(numbers)) {
    if (value !== "") payload[key] = Number(value);
  }

  // Старая цена: пустое поле = снять скидку (правка) или не задавать (создание).
  if (form.old_price !== "") payload.old_price = Number(form.old_price);
  else if (editing) payload.old_price = null;

  if (editing || Object.keys(form.specs).length > 0) payload.specs = form.specs;

  return payload;
}

export async function action({ request }: Route.ActionArgs) {
  const session = await requireAdminSession(request, { section: "products" });

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const productId = String(form.get("product_id") ?? "").trim();

  try {
    if (intent === "create" || intent === "update") {
      const formData = readProductForm(form);

      if (intent === "create") {
        // POST и PATCH возвращают `AdminProductDetail` напрямую, а не конверт
        // `{product, specs}` — конверт отдаёт только GET одного товара.
        const created = await serverFetch<AdminProductDetail>("/admin/products", {
          method: "POST",
          headers: session.jsonHeaders,
          body: JSON.stringify(productPayload(formData, false)),
        });

        // После создания открываем карточку созданного товара: id известен
        // только из ответа, иначе пришлось бы искать его поиском по списку.
        return data<ProductActionResult>({ ok: "Товар создан", edit: created.id }, { status: 200 });
      }

      if (!productId) {
        return data<ProductActionResult>({ error: "Не указан товар" }, { status: 400 });
      }
      await serverFetch<AdminProductDetail>(`/admin/products/${encodeURIComponent(productId)}`, {
        method: "PATCH",
        headers: session.jsonHeaders,
        body: JSON.stringify(productPayload(formData, true)),
      });
      return data<ProductActionResult>(
        { ok: "Изменения сохранены", edit: productId },
        { status: 200 },
      );
    }

    if (intent === "stock") {
      if (!productId) {
        return data<ProductActionResult>({ error: "Не указан товар" }, { status: 400 });
      }
      // `delta` со знаком: приход положительный, списание отрицательное.
      const delta = Number.parseInt(String(form.get("delta") ?? ""), 10);
      if (!Number.isFinite(delta) || delta === 0) {
        return data<ProductActionResult>(
          { error: "Укажите изменение остатка: положительное — приход, отрицательное — списание", errorCode: "invalid_delta", edit: productId },
          { status: 400 },
        );
      }

      await serverFetch(`/admin/products/${encodeURIComponent(productId)}/stock`, {
        method: "POST",
        headers: session.jsonHeaders,
        body: JSON.stringify({
          delta,
          reason: String(form.get("reason") ?? "").trim() || null,
        }),
      });

      return data<ProductActionResult>(
        {
          ok: delta > 0 ? `Приход ${delta} шт` : `Списано ${Math.abs(delta)} шт`,
          edit: productId,
        },
        { status: 200 },
      );
    }

    if (intent === "delete") {
      if (!productId) {
        return data<ProductActionResult>({ error: "Не указан товар" }, { status: 400 });
      }
      // 204 без тела: `serverFetch` вернёт undefined, тело ответа не нужно.
      await serverFetch(`/admin/products/${encodeURIComponent(productId)}`, {
        method: "DELETE",
        headers: session.headers,
      });
      return data<ProductActionResult>({ ok: "Товар удалён" }, { status: 200 });
    }

    return data<ProductActionResult>(
      { error: "Неизвестное действие", errorCode: "unknown_intent" },
      { status: 400 },
    );
  } catch (cause) {
    const info = describeApiError(cause, "Не удалось выполнить действие с товаром");
    return data<ProductActionResult>(
      {
        error: productErrorMessage(info),
        errorCode: info.code,
        fields: info.fields,
        // При неудаче держим открытой ту же карточку, иначе сотрудник потерял бы
        // заполненную форму и был бы вынужден вводить всё заново.
        edit: intent === "delete" ? "" : productId,
      },
      { status: info.status >= 400 && info.status < 500 ? info.status : 400 },
    );
  }
}

/**
 * Тексты ошибок товара.
 *
 * Для кодов, где backend уже сказал всё нужное дословно (артикул занят, масса
 * списания больше остатка, товар в заказах), показываем его сообщение: своя
 * формулировка отстала бы от текста на бэкенде и скрыла бы цифры.
 */
function productErrorMessage(info: ApiErrorInfo): string {
  switch (info.code) {
    case "sku_exists":
    case "slug_exists":
    case "negative_stock":
    case "product_in_orders":
    case "invalid_old_price":
      return info.message;
    case "insufficient_role":
      return "Раздел доступен только администратору.";
    case "validation_error":
      return info.fields._root ?? info.message;
    case "network_error":
      return "Сервер недоступен. Проверьте соединение и повторите действие.";
    default:
      return info.status >= 500
        ? "Сервер временно недоступен, действие не выполнено. Повторите через минуту."
        : info.message;
  }
}

export default function AdminProducts({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>() as ProductActionResult | undefined;
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const { filters, products, listError, categories, brands, editing, detailError } = loaderData;

  const busy = navigation.state !== "idle";
  const currentSearch = new URLSearchParams(searchParams);

  /** Ссылка на карточку товара сохраняет фильтры и сбрасывает страницу. */
  const editHref = (id: string): string => {
    const next = new URLSearchParams(currentSearch);
    next.delete("page");
    next.set("edit", id);
    return `/admin/products?${next.toString()}`;
  };

  /** Пустая форма создания: фильтры сохраняем, `edit` убираем. */
  const newHref = `/admin/products?${(() => {
    const next = new URLSearchParams(currentSearch);
    next.delete("page");
    next.delete("edit");
    next.set("new", "1");
    return next.toString();
  })()}`;

  return (
    <>
      <AdminPageHeader
        title="Товары"
        description="Создание, правка карточки, приход и списание остатков."
        actions={
          <a
            href={newHref}
            className="rounded-xl bg-pulse-600 px-4 py-2 text-sm font-semibold text-white hover:bg-pulse-700"
          >
            Добавить товар
          </a>
        }
      />

      <AdminNotice ok={actionData?.ok} error={actionData?.error} errorCode={actionData?.errorCode} />

      <FilterBar action="/admin/products">
        <FilterField id="products-search" label="Поиск">
          <input
            id="products-search"
            type="search"
            name="search"
            defaultValue={filters.search}
            placeholder="Название или артикул"
            className={ADMIN_INPUT}
          />
        </FilterField>

        <FilterField id="products-category" label="Категория">
          <select
            id="products-category"
            name="category_id"
            defaultValue={filters.categoryId}
            className={ADMIN_INPUT}
          >
            <option value="">Все категории</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </FilterField>

        <FilterField id="products-brand" label="Бренд">
          <select id="products-brand" name="brand_id" defaultValue={filters.brandId} className={ADMIN_INPUT}>
            <option value="">Все бренды</option>
            {brands.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.name}
              </option>
            ))}
          </select>
        </FilterField>

        <FilterField id="products-status" label="Статус">
          <select id="products-status" name="status" defaultValue={filters.status} className={ADMIN_INPUT}>
            <option value="">Все статусы</option>
            {PRODUCT_STATUS_VALUES.map((value) => (
              <option key={value} value={value}>
                {PRODUCT_STATUS_LABEL[value]}
              </option>
            ))}
          </select>
        </FilterField>

        <FilterField id="products-in-stock" label="В наличии">
          <select
            id="products-in-stock"
            name="in_stock"
            defaultValue={filters.inStock === null ? "" : String(filters.inStock)}
            className={ADMIN_INPUT}
          >
            <option value="">Любой</option>
            <option value="true">Есть</option>
            <option value="false">Нет</option>
          </select>
        </FilterField>

        <input type="hidden" name="limit" value={String(filters.limit)} />

        <button
          type="submit"
          className="rounded-xl bg-pulse-600 px-4 py-2 text-sm font-semibold text-white hover:bg-pulse-700"
        >
          Применить
        </button>
        <a
          href="/admin/products"
          className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Сбросить
        </a>
      </FilterBar>

      {listError ? (
        <div className="mt-5">
          <LoadError error={listError} />
        </div>
      ) : products && products.items.length > 0 ? (
        <AdminTable
          caption="Список товаров"
          headers={["Название", "Артикул", "Цена", "Остаток", "Статус", "Активен", "Обновлён", ""]}
        >
          {products.items.map((item) => (
            <tr key={item.id} className="hover:bg-slate-50">
              <AdminCell>
                <p className="font-medium text-slate-900">{item.name}</p>
                {item.old_price ? (
                  <p className="text-xs text-slate-500 line-through">{formatPrice(item.old_price)}</p>
                ) : null}
              </AdminCell>
              <AdminCell nowrap>
                <span className="text-slate-600">{item.sku ?? "—"}</span>
              </AdminCell>
              <AdminCell nowrap>
                <MoneyCell value={item.price} />
              </AdminCell>
              <AdminCell nowrap>{item.stock_quantity}</AdminCell>
              <AdminCell nowrap>
                <StatusBadge
                  label={PRODUCT_STATUS_LABEL[item.status] ?? item.status}
                  tone={statusTone(item.status)}
                />
              </AdminCell>
              <AdminCell nowrap>
                <span className={item.is_active ? "text-emerald-700" : "text-slate-500"}>
                  {item.is_active ? "да" : "нет"}
                </span>
              </AdminCell>
              <AdminCell nowrap>
                <DateCell value={item.updated_at} />
              </AdminCell>
              <AdminCell nowrap>
                <a
                  href={editHref(item.id)}
                  className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  Изменить
                </a>
              </AdminCell>
            </tr>
          ))}
        </AdminTable>
      ) : (
        <div className="mt-5">
          <EmptyState
            title="Товары не найдены"
            hint="Снимите фильтры или добавьте первый товар кнопкой выше."
          />
        </div>
      )}

      {products ? (
        <AdminPagination
          pathname="/admin/products"
          search={currentSearch}
          page={products.page}
          pages={products.pages}
          total={products.total}
        />
      ) : null}

      {editing ? (
        <>
          <ProductFormCard
            mode={editing.mode}
            product={editing.product}
            specs={editing.specs}
            categories={categories}
            brands={brands}
            fields={actionData?.fields ?? {}}
            busy={busy}
          />
          {/* Остаток и удаление — только у существующего товара: у нового их
              ещё нет, а id появляется лишь после создания. */}
          {editing.product ? <StockAdjustForm product={editing.product} busy={busy} /> : null}
        </>
      ) : detailError ? (
        <div className="mt-8">
          <LoadError error={detailError} />
        </div>
      ) : null}
    </>
  );
}

/** Карточка формы: создание или правка одного товара. */
function ProductFormCard({
  mode,
  product,
  specs,
  categories,
  brands,
  fields,
  busy,
}: {
  mode: "create" | "edit";
  product: AdminProductDetail | null;
  specs: Record<string, string>;
  categories: AdminCategoryRef[];
  brands: AdminBrand[];
  fields: Record<string, string>;
  busy: boolean;
}) {
  const specEntries = Object.entries(specs);
  // Пустых строк характеристик даём с запасом: без JS добавить пару нельзя,
  // а шаблон списка не собирается.
  const specRows = Math.max(specEntries.length + 2, 4);

  return (
    <section aria-labelledby="product-form" className="card mt-8 p-5">
      <h2 id="product-form" className="text-lg font-semibold text-slate-900">
        {mode === "create" ? "Новый товар" : `Правка: ${product?.name ?? "товар"}`}
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        {product
          ? `Создан ${formatDateTime(product.created_at)}. Артикул занят — менять его стоит с осторожностью.`
          : "Обязательны название, артикул, категория и цена."}
      </p>

      <Form method="post" className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <input type="hidden" name="intent" value={mode === "create" ? "create" : "update"} />
        {product ? <input type="hidden" name="product_id" value={product.id} /> : null}

        <AdminField id="product-name" label="Название" error={fields.name} required>
          <input
            id="product-name"
            name="name"
            defaultValue={product?.name ?? ""}
            maxLength={300}
            required
            aria-invalid={fields.name ? true : undefined}
            className={`${ADMIN_INPUT} ${fields.name ? "border-rose-400" : ""}`}
          />
        </AdminField>

        <AdminField id="product-sku" label="Артикул" error={fields.sku} required>
          <input
            id="product-sku"
            name="sku"
            defaultValue={product?.sku ?? ""}
            maxLength={64}
            required
            aria-invalid={fields.sku ? true : undefined}
            className={`${ADMIN_INPUT} ${fields.sku ? "border-rose-400" : ""}`}
          />
        </AdminField>

        <AdminField id="product-slug" label="Адрес (slug)" error={fields.slug} hint="Пусто — сгенерируем из названия.">
          <input
            id="product-slug"
            name="slug"
            defaultValue={product?.slug ?? ""}
            maxLength={300}
            className={`${ADMIN_INPUT} ${fields.slug ? "border-rose-400" : ""}`}
          />
        </AdminField>

        <AdminField id="product-category" label="Категория" error={fields.category_id} required>
          <select
            id="product-category"
            name="category_id"
            defaultValue={product?.category_id ?? ""}
            required
            className={ADMIN_INPUT}
          >
            <option value="">Выберите категорию</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </AdminField>

        <AdminField id="product-brand" label="Бренд" error={fields.brand_id} hint="Необязательно.">
          <select id="product-brand" name="brand_id" defaultValue={product?.brand_id ?? ""} className={ADMIN_INPUT}>
            <option value="">Без бренда</option>
            {brands.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.name}
              </option>
            ))}
          </select>
        </AdminField>

        <AdminField id="product-price" label="Цена, ₽" error={fields.price} required>
          <input
            id="product-price"
            name="price"
            type="number"
            min={0}
            step="0.01"
            defaultValue={product?.price ?? ""}
            required
            className={`${ADMIN_INPUT} ${fields.price ? "border-rose-400" : ""}`}
          />
        </AdminField>

        <AdminField
          id="product-old-price"
          label="Старая цена, ₽"
          error={fields.old_price}
          hint="Должна быть больше текущей цены."
        >
          <input
            id="product-old-price"
            name="old_price"
            type="number"
            min={0}
            step="0.01"
            defaultValue={product?.old_price ?? ""}
            className={`${ADMIN_INPUT} ${fields.old_price ? "border-rose-400" : ""}`}
          />
        </AdminField>

        <AdminField id="product-purchase-price" label="Закупочная цена, ₽" error={fields.purchase_price}>
          <input
            id="product-purchase-price"
            name="purchase_price"
            type="number"
            min={0}
            step="0.01"
            defaultValue={product?.purchase_price ?? ""}
            className={ADMIN_INPUT}
          />
        </AdminField>

        <AdminField id="product-stock" label="Остаток, шт" error={fields.stock_quantity}>
          <input
            id="product-stock"
            name="stock_quantity"
            type="number"
            min={0}
            defaultValue={product?.stock_quantity ?? ""}
            className={ADMIN_INPUT}
          />
        </AdminField>

        <AdminField id="product-min-stock" label="Минимальный остаток, шт" error={fields.min_stock}>
          <input
            id="product-min-stock"
            name="min_stock"
            type="number"
            min={0}
            defaultValue={product ? String(product.min_stock) : ""}
            className={ADMIN_INPUT}
          />
        </AdminField>

        <AdminField id="product-status" label="Статус" error={fields.status}>
          <select id="product-status" name="status" defaultValue={product?.status ?? "in_stock"} className={ADMIN_INPUT}>
            {PRODUCT_STATUS_VALUES.map((value) => (
              <option key={value} value={value}>
                {PRODUCT_STATUS_LABEL[value]}
              </option>
            ))}
          </select>
        </AdminField>

        <AdminField id="product-warranty" label="Гарантия, мес." error={fields.warranty_months}>
          <input
            id="product-warranty"
            name="warranty_months"
            type="number"
            min={0}
            max={600}
            defaultValue={product ? String(product.warranty_months) : ""}
            className={ADMIN_INPUT}
          />
        </AdminField>

        <div className="flex items-center gap-2 sm:col-span-2 lg:col-span-3">
          <input
            id="product-active"
            name="is_active"
            type="checkbox"
            defaultChecked={product ? product.is_active : true}
            className="h-4 w-4 rounded border-slate-300"
          />
          <label htmlFor="product-active" className="text-sm text-slate-800">
            Товар виден в магазине
          </label>
        </div>

        <div className="sm:col-span-2 lg:col-span-3">
          <AdminField id="product-short" label="Краткое описание" error={fields.short_description}>
            <AdminTextarea
              id="product-short"
              name="short_description"
              rows={2}
              defaultValue={product?.short_description ?? ""}
            />
          </AdminField>
        </div>

        <div className="sm:col-span-2 lg:col-span-3">
          <AdminField id="product-description" label="Полное описание" error={fields.description}>
            <AdminTextarea
              id="product-description"
              name="description"
              rows={5}
              defaultValue={product?.description ?? ""}
            />
          </AdminField>
        </div>

        <fieldset className="sm:col-span-2 lg:col-span-3">
          <legend className="text-sm font-medium text-slate-800">Характеристики</legend>
          <p className="mt-1 text-xs text-slate-500">
            Ключ и значение сохраняются как есть: например <code>cpu.cores</code> и 6.
          </p>
          <div className="mt-2 space-y-2">
            {Array.from({ length: specRows }, (_, index) => {
              const entry = specEntries[index];
              return (
                <div key={index} className="flex flex-wrap gap-2">
                  <label htmlFor={`spec_key_${index}`} className="sr-only">
                    Ключ характеристики {index + 1}
                  </label>
                  <input
                    id={`spec_key_${index}`}
                    name={`spec_key_${index}`}
                    defaultValue={entry?.[0] ?? ""}
                    placeholder="Ключ"
                    className={`${ADMIN_INPUT} max-w-48 flex-1 basis-40`}
                  />
                  <label htmlFor={`spec_value_${index}`} className="sr-only">
                    Значение характеристики {index + 1}
                  </label>
                  <input
                    id={`spec_value_${index}`}
                    name={`spec_value_${index}`}
                    defaultValue={entry?.[1] ?? ""}
                    placeholder="Значение"
                    className={`${ADMIN_INPUT} flex-1 basis-48`}
                  />
                </div>
              );
            })}
          </div>
        </fieldset>

        <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-3">
          <ActionButton
            intent={mode === "create" ? "create" : "update"}
            tone="primary"
            busy={busy}
            busyLabel="Сохраняем…"
          >
            {mode === "create" ? "Создать товар" : "Сохранить изменения"}
          </ActionButton>
        </div>
      </Form>
    </section>
  );
}

/**
 * Остаток отдельной формой.
 *
 * Не в общей форме товара намеренно: `POST /products/{id}/stock` ведёт журнал
 * прихода и списания, и правильное изменение остатка не должно зависеть от
 * того, открыл ли сотрудник форму правки.
 */
function StockAdjustForm({ product, busy }: { product: AdminProductDetail; busy: boolean }) {
  return (
    <section aria-labelledby="stock-form" className="card mt-6 p-5">
      <h2 id="stock-form" className="text-lg font-semibold text-slate-900">
        Остаток
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        Сейчас на складе {product.stock_quantity} шт, зарезервировано {product.reserved_quantity}.
        Приход — положительное число, списание — отрицательное.
      </p>

      <Form method="post" className="mt-4 grid gap-4 sm:grid-cols-3">
        <input type="hidden" name="intent" value="stock" />
        <input type="hidden" name="product_id" value={product.id} />

        <AdminField id="stock-delta" label="Изменение, шт" required>
          <input
            id="stock-delta"
            name="delta"
            type="number"
            step={1}
            required
            className={ADMIN_INPUT}
            placeholder="10 или -2"
          />
        </AdminField>

        <AdminField id="stock-reason" label="Причина">
          <input
            id="stock-reason"
            name="reason"
            maxLength={200}
            placeholder="Поставка от поставщика / брак"
            className={ADMIN_INPUT}
          />
        </AdminField>

        <div className="flex items-end">
          <ActionButton intent="stock" busy={busy} busyLabel="Применяем…">
            Применить
          </ActionButton>
        </div>
      </Form>

      <Form
        method="post"
        className="mt-4 border-t border-slate-200 pt-4"
        onSubmit={(event) => {
          // Удаление необратимо, поэтому подтверждаем; без JS форма уйдёт как
          // есть, а backend откажет, если товар уже участвует в заказах.
          if (
            typeof window !== "undefined" &&
            !window.confirm(`Удалить товар «${product.name}»? Действие необратимо.`)
          ) {
            event.preventDefault();
          }
        }}
      >
        <input type="hidden" name="intent" value="delete" />
        <input type="hidden" name="product_id" value={product.id} />
        <ActionButton intent="delete" tone="danger" busy={busy} busyLabel="Удаляем…">
          Удалить товар
        </ActionButton>
      </Form>
    </section>
  );
}
