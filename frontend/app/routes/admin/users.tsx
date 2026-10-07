import { data, Form, useActionData, useNavigation, useSearchParams } from "react-router";

import type { Route } from "./+types/users";

import type { AdminPage, AdminUserListItem } from "~/lib/admin";
import type { ApiErrorInfo } from "~/lib/api-error";
import { describeApiError } from "~/lib/api-error";
import { serverFetch } from "~/lib/api.server";
import { queryString, requireAdminSession } from "~/lib/admin.server";
import {
  ROLE_LABEL,
  USER_ROLE_VALUES,
  isUserRole,
  parseBoolParam,
  parseLimit,
  parsePage,
} from "~/lib/admin";
import {
  ADMIN_INPUT,
  ActionButton,
  AdminCell,
  AdminField,
  AdminNotice,
  AdminPagination,
  AdminTable,
  DateCell,
  EmptyState,
  FilterBar,
  FilterField,
  LoadError,
} from "~/widgets/admin-ui";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Пользователи — Админ-панель — ПУЛЬС" }];
}

/**
 * Пользователи: список, смена роли, блокировка, сброс пароля.
 *
 * Раздел только для администратора (ТЗ 3.4).
 *
 * ВАЖНО про контракт: `PATCH /admin/users/{id}` принимает `role`, `is_blocked`
 * и `password` в QUERY-строке, а не в теле. Проверено живым запросом: с телом
 * backend отвечает 422, а с query применяет изменение. Поэтому action строит
 * URL через `queryString`, а `serverFetch` уходит без `body`.
 */

type UserFilters = {
  search: string;
  role: string;
  isBlocked: boolean | null;
  page: number;
  limit: number;
};

function readFilters(url: URL): UserFilters {
  return {
    search: (url.searchParams.get("search") ?? "").trim(),
    role: (url.searchParams.get("role") ?? "").trim(),
    isBlocked: parseBoolParam(url.searchParams.get("is_blocked")),
    page: parsePage(url.searchParams.get("page")),
    limit: parseLimit(url.searchParams.get("limit")),
  };
}

type UserActionResult = {
  ok?: string;
  error?: string;
  errorCode?: string;
  fields?: Record<string, string>;
};

export async function loader({ request }: Route.LoaderArgs) {
  const session = await requireAdminSession(request, { section: "users" });
  const url = new URL(request.url);
  const filters = readFilters(url);

  const users = await serverFetch<AdminPage<AdminUserListItem>>(
    `/admin/users${queryString({
      page: filters.page,
      limit: filters.limit,
      search: filters.search,
      role: filters.role,
      // `null` — фильтр не задан; строкой, потому что `queryString` принимает
      // только строки и числа, а backend ждёт `true | false`.
      is_blocked: filters.isBlocked === null ? null : String(filters.isBlocked),
    })}`,
    { headers: session.headers },
  ).catch((cause: unknown) => cause as ApiErrorInfo);

  const error = users instanceof Error ? describeApiError(users, "Не удалось загрузить пользователей") : null;

  return {
    /** Нужен форме: сотрудник не должен предлагать сменить роль самому себе. */
    currentUserId: session.user.id,
    filters,
    users: error ? null : (users as AdminPage<AdminUserListItem>),
    error,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const session = await requireAdminSession(request, { section: "users" });

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const field = (name: string): string => String(form.get(name) ?? "").trim();
  const userId = field("user_id");

  if (!userId) {
    return data<UserActionResult>({ error: "Не указан пользователь" }, { status: 400 });
  }

  const url = `/admin/users/${encodeURIComponent(userId)}`;

  try {
    if (intent === "role") {
      const role = field("role");
      if (!isUserRole(role)) {
        return data<UserActionResult>({ error: "Выберите роль" }, { status: 400 });
      }
      // Роль идёт в query: см. предупреждение в шапке модуля.
      await serverFetch(`${url}${queryString({ role })}`, { method: "PATCH", headers: session.headers });
      return data<UserActionResult>({ ok: `Роль изменена: ${ROLE_LABEL[role] ?? role}` }, { status: 200 });
    }

    if (intent === "block" || intent === "unblock") {
      const isBlocked = intent === "block";
      await serverFetch(`${url}${queryString({ is_blocked: String(isBlocked) })}`, {
        method: "PATCH",
        headers: session.headers,
      });
      return data<UserActionResult>(
        { ok: isBlocked ? "Пользователь заблокирован" : "Блокировка снята" },
        { status: 200 },
      );
    }

    if (intent === "password") {
      const password = field("password");
      if (password.length < 8) {
        return data<UserActionResult>(
          {
            error: "Пароль должен быть не короче 8 символов",
            errorCode: "invalid_password",
            fields: { password: "минимум 8 символов" },
          },
          { status: 400 },
        );
      }
      await serverFetch(`${url}${queryString({ password })}`, {
        method: "PATCH",
        headers: session.headers,
      });
      return data<UserActionResult>({ ok: "Пароль сброшен" }, { status: 200 });
    }

    return data<UserActionResult>({ error: "Неизвестное действие" }, { status: 400 });
  } catch (cause) {
    const info = describeApiError(cause, "Не удалось выполнить действие с пользователем");
    return data<UserActionResult>(
      {
        error: userErrorMessage(info),
        errorCode: info.code,
        fields: info.fields,
      },
      { status: info.status >= 400 && info.status < 500 ? info.status : 400 },
    );
  }
}

/**
 * Тексты ошибок пользователей.
 *
 * `cannot_change_own_role` и `cannot_block_self` приходят с бэкенда готовыми к
 * показу: это ограничения безопасности, и подменять их своей формулировкой
 * значило бы объяснять сотруднику несуществующую возможность.
 */
function userErrorMessage(info: ApiErrorInfo): string {
  switch (info.code) {
    case "cannot_block_self":
    case "cannot_change_own_role":
    case "last_admin":
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

export default function AdminUsers({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>() as UserActionResult | undefined;
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const { currentUserId, filters, users, error } = loaderData;

  const busy = navigation.state !== "idle";
  const currentSearch = new URLSearchParams(searchParams);

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Пользователи</h1>
          <p className="mt-1 text-sm text-slate-600">
            Роли, блокировка и сброс пароля. Свою роль и свою блокировку менять нельзя —
            это ограничение сервера.
          </p>
        </div>
      </div>

      <AdminNotice ok={actionData?.ok} error={actionData?.error} errorCode={actionData?.errorCode} />

      <FilterBar action="/admin/users">
        <FilterField id="users-search" label="Поиск">
          <input
            id="users-search"
            type="search"
            name="search"
            defaultValue={filters.search}
            placeholder="Имя, e-mail или телефон"
            className={ADMIN_INPUT}
          />
        </FilterField>

        <FilterField id="users-role" label="Роль">
          <select id="users-role" name="role" defaultValue={filters.role} className={ADMIN_INPUT}>
            <option value="">Все роли</option>
            {USER_ROLE_VALUES.map((value) => (
              <option key={value} value={value}>
                {ROLE_LABEL[value] ?? value}
              </option>
            ))}
          </select>
        </FilterField>

        <FilterField id="users-blocked" label="Блокировка">
          <select
            id="users-blocked"
            name="is_blocked"
            defaultValue={filters.isBlocked === null ? "" : String(filters.isBlocked)}
            className={ADMIN_INPUT}
          >
            <option value="">Любые</option>
            <option value="true">Заблокированные</option>
            <option value="false">Активные</option>
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
          href="/admin/users"
          className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Сбросить
        </a>
      </FilterBar>

      {error ? (
        <div className="mt-5">
          <LoadError error={error} />
        </div>
      ) : users && users.items.length > 0 ? (
        <AdminTable
          caption="Список пользователей"
          headers={["Пользователь", "Роль", "Заказы", "Регистрация", "Вход", "Статус", "Действия"]}
        >
          {users.items.map((item) => (
            <tr key={item.id} className="align-top hover:bg-slate-50">
              <AdminCell>
                <p className="font-medium text-slate-900">
                  {item.first_name} {item.last_name}
                </p>
                <p className="text-xs text-slate-600">{item.email}</p>
                {item.phone ? <p className="text-xs text-slate-600">{item.phone}</p> : null}
              </AdminCell>
              <AdminCell nowrap>
                <span className="text-sm text-slate-800">{ROLE_LABEL[item.role] ?? item.role}</span>
              </AdminCell>
              <AdminCell nowrap>{item.orders_count}</AdminCell>
              <AdminCell nowrap>
                <DateCell value={item.created_at} />
              </AdminCell>
              <AdminCell nowrap>
                <DateCell value={item.last_login_at} />
              </AdminCell>
              <AdminCell nowrap>
                {item.blocked_at ? (
                  <span className="rounded-lg bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">
                    Заблокирован
                  </span>
                ) : (
                  <span className="rounded-lg bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">
                    Активен
                  </span>
                )}
              </AdminCell>
              <AdminCell>
                <UserActions
                  user={item}
                  // `UserOut.id` объявлен числом, а `/auth/me` отдаёт UUID строкой,
                  // поэтому сравниваем через String — иначе «я» не совпало бы само с собой.
                  isSelf={String(item.id) === String(currentUserId)}
                  busy={busy}
                  fields={actionData?.fields ?? {}}
                />
              </AdminCell>
            </tr>
          ))}
        </AdminTable>
      ) : (
        <div className="mt-5">
          <EmptyState title="Пользователи не найдены" hint="Измените фильтры или поисковый запрос." />
        </div>
      )}

      {users ? (
        <AdminPagination
          pathname="/admin/users"
          search={currentSearch}
          page={users.page}
          pages={users.pages}
          total={users.total}
        />
      ) : null}

      </>
  );
}

/**
 * Действия над пользователем: роль, блокировка, сброс пароля.
 *
 * Три отдельные формы вместо одной: у них разные наборы полей, и общая форма
 * означала бы, что смена роли заодно стирает введённый пароль (или наоборот).
 *
 * Свою строку скрываем частично: форму смены роли и блокировки для себя не
 * показываем — сервер всё равно откажет (`cannot_change_own_role`,
 * `cannot_block_self`), и сотрудник лишь потратил бы попытку.
 */
function UserActions({
  user,
  isSelf,
  busy,
  fields,
}: {
  user: AdminUserListItem;
  isSelf: boolean;
  busy: boolean;
  fields: Record<string, string>;
}) {
  return (
    <div className="space-y-3">
      <Form method="post" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="intent" value="role" />
        <input type="hidden" name="user_id" value={user.id} />
        <div>
          <label htmlFor={`role-${user.id}`} className="block text-xs font-medium text-slate-600">
            Роль
          </label>
          <select
            id={`role-${user.id}`}
            name="role"
            defaultValue={user.role}
            disabled={isSelf}
            className={`${ADMIN_INPUT} mt-1 w-40 disabled:cursor-not-allowed disabled:bg-slate-50`}
          >
            {USER_ROLE_VALUES.map((value) => (
              <option key={value} value={value}>
                {ROLE_LABEL[value] ?? value}
              </option>
            ))}
          </select>
        </div>
        <ActionButton intent="role" busy={busy} busyLabel="Меняем…" disabled={isSelf}>
          Сменить
        </ActionButton>
      </Form>

      <Form method="post" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="intent" value={user.blocked_at ? "unblock" : "block"} />
        <input type="hidden" name="user_id" value={user.id} />
        <ActionButton
          intent={user.blocked_at ? "unblock" : "block"}
          tone={user.blocked_at ? "default" : "danger"}
          busy={busy}
          busyLabel="Применяем…"
          disabled={isSelf}
        >
          {user.blocked_at ? "Разблокировать" : "Заблокировать"}
        </ActionButton>
      </Form>

      <Form method="post" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="intent" value="password" />
        <input type="hidden" name="user_id" value={user.id} />
        <AdminField
          id={`password-${user.id}`}
          label="Новый пароль"
          error={fields.password}
          hint="Минимум 8 символов."
        >
          <input
            id={`password-${user.id}`}
            name="password"
            type="password"
            minLength={8}
            maxLength={128}
            autoComplete="new-password"
            className={`${ADMIN_INPUT} w-44`}
          />
        </AdminField>
        <ActionButton intent="password" busy={busy} busyLabel="Сбрасываем…">
          Сбросить
        </ActionButton>
      </Form>
    </div>
  );
}