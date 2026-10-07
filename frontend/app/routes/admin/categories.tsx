import { data, Form, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/categories";

import type { AdminBrand, AdminCategoryRef } from "~/lib/admin";
import type { ApiErrorInfo } from "~/lib/api-error";
import { describeApiError } from "~/lib/api-error";
import { serverFetch } from "~/lib/api.server";
import { requireAdminSession } from "~/lib/admin.server";
import {
  ADMIN_INPUT,
  ActionButton,
  AdminCell,
  AdminField,
  AdminNotice,
  AdminPageHeader,
  AdminTable,
  EmptyState,
  LoadError,
  StatusBadge,
} from "~/widgets/admin-ui";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Категории и бренды — Админ-панель — ПУЛЬС" }];
}

/**
 * Справочники: категории и бренды.
 *
 * Раздел только для администратора (ТЗ 3.4). Справочники нужны формам создания и
 * правки товара, поэтому живут в общей таблице маршрутов рядом с ними.
 *
 * API даёт только `GET` и `POST` — правки и удаления в контракте нет, поэтому
 * раздел строго на создание: показывать несуществующие кнопки «удалить» значило
 * бы обнаруживать пользователя на 405.
 *
 * Категории приходят деревом, поэтому список разворачиваем в плоский с
 * отступом по уровню — иначе вложенность была бы видна только визуально и
 * пропадала бы при чтении с экрана.
 */

type CategoryResponse = { items: AdminCategoryRef[]; total: number };
type BrandResponse = { items: AdminBrand[]; total: number };

type CategoryActionResult = {
  ok?: string;
  error?: string;
  errorCode?: string;
  fields?: Record<string, string>;
};

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdminSession(request, { section: "categories" });

  // Справочники независимы: падение одного не должно скрывать второй.
  const [categories, brands] = await Promise.all([
    serverFetch<CategoryResponse>("/admin/categories").catch((cause: unknown) => cause as ApiErrorInfo),
    serverFetch<BrandResponse>("/admin/brands").catch((cause: unknown) => cause as ApiErrorInfo),
  ]);

  const categoryError =
    categories instanceof Error ? describeApiError(categories, "Не удалось загрузить категории") : null;
  const brandError =
    brands instanceof Error ? describeApiError(brands, "Не удалось загрузить бренды") : null;

  return {
    categories: categoryError ? null : (categories as CategoryResponse).items,
    categoryError,
    brands: brandError ? null : (brands as BrandResponse).items,
    brandError,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const session = await requireAdminSession(request, { section: "categories" });

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const field = (name: string): string => String(form.get(name) ?? "").trim();

  try {
    if (intent === "create_category" || intent === "create_brand") {
      const name = field("name");
      if (name.length < 2) {
        return data<CategoryActionResult>(
          { error: "Название должно быть не короче 2 символов", fields: { name: "минимум 2 символа" } },
          { status: 400 },
        );
      }

      const isCategory = intent === "create_category";
      const payload: Record<string, string | null> = { name };

      const slug = field("slug");
      if (slug !== "") payload.slug = slug;
      // Родитель необязателен: без него категория станет корневой.
      if (isCategory) payload.parent_id = field("parent_id") || null;

      await serverFetch(isCategory ? "/admin/categories" : "/admin/brands", {
        method: "POST",
        headers: session.jsonHeaders,
        body: JSON.stringify(payload),
      });

      return data<CategoryActionResult>(
        { ok: `${isCategory ? "Категория" : "Бренд"} «${name}» создан${isCategory ? "а" : ""}` },
        { status: 200 },
      );
    }

    return data<CategoryActionResult>({ error: "Неизвестное действие" }, { status: 400 });
  } catch (cause) {
    const info = describeApiError(cause, "Не удалось сохранить справочник");
    return data<CategoryActionResult>(
      {
        error: info.code === "insufficient_role" ? "Раздел доступен только администратору." : info.message,
        errorCode: info.code,
        fields: info.fields,
      },
      { status: info.status >= 400 && info.status < 500 ? info.status : 400 },
    );
  }
}

export default function AdminCategories({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>() as CategoryActionResult | undefined;
  const navigation = useNavigation();
  const { categories, categoryError, brands, brandError } = loaderData;
  const busy = navigation.state !== "idle";

  const flatCategories = categories ? flattenCategories(categories) : [];

  return (
    <>
      <AdminPageHeader
        title="Категории и бренды"
        description="Справочники каталога. Правка и удаление в API пока не предусмотрены."
      />

      <AdminNotice ok={actionData?.ok} error={actionData?.error} errorCode={actionData?.errorCode} />

      <section aria-labelledby="category-create" className="card mt-5 p-5">
        <h2 id="category-create" className="text-lg font-semibold text-slate-900">
          Новая категория
        </h2>
        <Form method="post" className="mt-4 grid gap-4 sm:grid-cols-4 sm:items-end">
          <input type="hidden" name="intent" value="create_category" />

          <AdminField id="category-name" label="Название" error={actionData?.fields?.name} required>
            <input id="category-name" name="name" maxLength={150} required className={ADMIN_INPUT} />
          </AdminField>

          <AdminField id="category-slug" label="Адрес (slug)" error={actionData?.fields?.slug} hint="Пусто — из названия.">
            <input id="category-slug" name="slug" maxLength={150} className={ADMIN_INPUT} />
          </AdminField>

          <AdminField id="category-parent" label="Вложить в категорию">
            <select id="category-parent" name="parent_id" defaultValue="" className={ADMIN_INPUT}>
              <option value="">Верхний уровень</option>
              {flatCategories.map((category) => (
                <option key={category.id} value={category.id}>
                  {`${"· ".repeat(Math.max(category.level - 1, 0))}${category.name}`}
                </option>
              ))}
            </select>
          </AdminField>

          <div>
            <ActionButton intent="create_category" tone="primary" busy={busy} busyLabel="Создаём…">
              Создать
            </ActionButton>
          </div>
        </Form>
      </section>

      <section aria-labelledby="category-list" className="mt-8">
        <h2 id="category-list" className="text-lg font-semibold text-slate-900">
          Категории
        </h2>
        {categoryError ? (
          <div className="mt-3">
            <LoadError error={categoryError} />
          </div>
        ) : flatCategories.length > 0 ? (
          <AdminTable caption="Список категорий" headers={["Название", "Адрес", "Уровень", "Вложенных"]}>
            {flatCategories.map((category) => (
              <tr key={category.id} className="hover:bg-slate-50">
                <AdminCell>
                  {/* Отступ по уровню показывает вложенность и в тексте,
                      а не только цветом, — иначе её не прочесть с экрана. */}
                  <span style={{ paddingInlineStart: `${Math.max(category.level - 1, 0) * 1.25}rem` }}>
                    {`${"· ".repeat(Math.max(category.level - 1, 0))}${category.name}`}
                  </span>
                </AdminCell>
                <AdminCell nowrap>
                  <span className="text-xs text-slate-600">{category.slug}</span>
                </AdminCell>
                <AdminCell nowrap>{category.level}</AdminCell>
                <AdminCell nowrap>{category.children.length}</AdminCell>
              </tr>
            ))}
          </AdminTable>
        ) : (
          <div className="mt-3">
            <EmptyState title="Категорий нет" hint="Создайте первую категорию формой выше." />
          </div>
        )}
      </section>

      <section aria-labelledby="brand-create" className="card mt-8 p-5">
        <h2 id="brand-create" className="text-lg font-semibold text-slate-900">
          Новый бренд
        </h2>
        <Form method="post" className="mt-4 grid gap-4 sm:grid-cols-4 sm:items-end">
          <input type="hidden" name="intent" value="create_brand" />

          <AdminField id="brand-name" label="Название" error={actionData?.fields?.name} required>
            <input id="brand-name" name="name" maxLength={150} required className={ADMIN_INPUT} />
          </AdminField>

          <AdminField id="brand-slug" label="Адрес (slug)" error={actionData?.fields?.slug}>
            <input id="brand-slug" name="slug" maxLength={150} className={ADMIN_INPUT} />
          </AdminField>

          <div className="sm:col-span-2">
            <ActionButton intent="create_brand" busy={busy} busyLabel="Создаём…">
              Создать бренд
            </ActionButton>
          </div>
        </Form>
      </section>

      <section aria-labelledby="brand-list" className="mt-8">
        <h2 id="brand-list" className="text-lg font-semibold text-slate-900">
          Бренды
        </h2>
        {brandError ? (
          <div className="mt-3">
            <LoadError error={brandError} />
          </div>
        ) : brands && brands.length > 0 ? (
          <AdminTable caption="Список брендов" headers={["Название", "Адрес", "Статус"]}>
            {brands.map((brand) => (
              <tr key={brand.id} className="hover:bg-slate-50">
                <AdminCell>
                  <span className="font-medium text-slate-900">{brand.name}</span>
                </AdminCell>
                <AdminCell nowrap>
                  <span className="text-xs text-slate-600">{brand.slug}</span>
                </AdminCell>
                <AdminCell nowrap>
                  <StatusBadge
                    label={brand.is_active ? "Активен" : "Скрыт"}
                    tone={brand.is_active ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-700"}
                  />
                </AdminCell>
              </tr>
            ))}
          </AdminTable>
        ) : (
          <div className="mt-3">
            <EmptyState title="Брендов нет" hint="Создайте первый бренд формой выше." />
          </div>
        )}
      </section>
    </>
  );
}

/**
 * Дерево → плоский список с сохранённым уровнем.
 *
 * Порядок обхода — «сначала родитель, потом дети»: иначе подкатегория
 * оказалась бы в таблице раньше своей родительской категории.
 */
function flattenCategories(nodes: AdminCategoryRef[]): AdminCategoryRef[] {
  const result: AdminCategoryRef[] = [];

  const walk = (list: AdminCategoryRef[]): void => {
    for (const node of list) {
      result.push(node);
      if (node.children.length > 0) walk(node.children);
    }
  };

  walk(nodes);
  return result;
}
