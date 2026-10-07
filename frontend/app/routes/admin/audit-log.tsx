import { useSearchParams } from "react-router";

import type { Route } from "./+types/audit-log";

import type { AdminAuditLogItem, AdminPage } from "~/lib/admin";
import type { ApiErrorInfo } from "~/lib/api-error";
import { describeApiError } from "~/lib/api-error";
import { serverFetch } from "~/lib/api.server";
import { requireAdminSession } from "~/lib/admin.server";
import { parseLimit, parsePage } from "~/lib/admin";
import {
  ADMIN_INPUT,
  AdminCell,
  AdminPagination,
  AdminTable,
  DateCell,
  EmptyState,
  FilterBar,
  FilterField,
  LoadError,
} from "~/widgets/admin-ui";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Журнал действий — Админ-панель — ПУЛЬС" }];
}

/**
 * Журнал действий сотрудников.
 *
 * Раздел только для администратора и только на чтение: править записи журнала
 * нельзя ни через API, ни здесь — это единственный способ установить, кто и
 * когда сменил статус заказа или удалил товар.
 *
 * Размер страницы берём побольше (50), потому что по журналу ищут вчерашнее
 * событие, а не листают каталог.
 */

const DEFAULT_LIMIT = 50;

export async function loader({ request }: Route.LoaderArgs) {
  const session = await requireAdminSession(request, { section: "audit-log" });

  const url = new URL(request.url);
  const page = parsePage(url.searchParams.get("page"));
  const limit = parseLimit(url.searchParams.get("limit"), DEFAULT_LIMIT);

  // Заголовки обязательны: `/admin/audit-log` отвечает 401 гостю.
  const log = await serverFetch<AdminPage<AdminAuditLogItem>>(
    `/admin/audit-log?page=${page}&limit=${limit}`,
    { headers: session.headers },
  ).catch((cause: unknown) => cause as ApiErrorInfo);

  const error = log instanceof Error ? describeApiError(log, "Не удалось загрузить журнал") : null;

  return {
    log: error ? null : (log as AdminPage<AdminAuditLogItem>),
    error,
  };
}

export default function AdminAuditLog({ loaderData }: Route.ComponentProps) {
  const [searchParams] = useSearchParams();
  const { log, error } = loaderData;
  const currentSearch = new URLSearchParams(searchParams);

  return (
    <>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Журнал действий</h1>
        <p className="mt-1 text-sm text-slate-600">
          Кто, когда и что изменил. Записи не редактируются и не удаляются.
        </p>
      </div>

      {error ? (
        <div className="mt-5">
          <LoadError error={error} />
        </div>
      ) : log && log.items.length > 0 ? (
        <>
          <AdminTable
            caption="Журнал действий сотрудников"
            headers={["Когда", "Сотрудник", "Действие", "Объект", "Подробности", "IP"]}
          >
            {log.items.map((item) => (
              <tr key={item.id} className="align-top hover:bg-slate-50">
                <AdminCell nowrap>
                  <DateCell value={item.created_at} />
                </AdminCell>
                <AdminCell nowrap>
                  <span className="font-mono text-xs text-slate-700">
                    {item.user_id ? item.user_id.slice(0, 8) : "—"}
                  </span>
                </AdminCell>
                <AdminCell nowrap>
                  <span className="text-sm font-medium text-slate-900">{item.action}</span>
                </AdminCell>
                <AdminCell nowrap>
                  {item.entity_type ? (
                    <span className="text-xs text-slate-700">
                      {item.entity_type}
                      {item.entity_id ? ` · ${item.entity_id.slice(0, 8)}` : ""}
                    </span>
                  ) : (
                    <span className="text-xs text-slate-500">—</span>
                  )}
                </AdminCell>
                <AdminCell>
                  <AuditDetails details={item.details} />
                </AdminCell>
                <AdminCell nowrap>
                  <span className="text-xs text-slate-600">{item.ip_address ?? "—"}</span>
                </AdminCell>
              </tr>
            ))}
          </AdminTable>

          <AdminPagination
            pathname="/admin/audit-log"
            search={currentSearch}
            page={log.page}
            pages={log.pages}
            total={log.total}
          />
        </>
      ) : (
        <div className="mt-5">
          <EmptyState title="Записей нет" hint="Журнал заполняется по мере действий сотрудников." />
        </div>
      )}

      <FilterBar action="/admin/audit-log">
        <FilterField id="audit-limit" label="Записей на странице">
          <select
            id="audit-limit"
            name="limit"
            defaultValue={String(currentSearch.get("limit") ?? DEFAULT_LIMIT)}
            className={ADMIN_INPUT}
          >
            {[25, 50, 100].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </FilterField>

        <button
          type="submit"
          className="rounded-xl bg-pulse-600 px-4 py-2 text-sm font-semibold text-white hover:bg-pulse-700"
        >
          Применить
        </button>
      </FilterBar>
    </>
  );
}

/**
 * Подробности события.
 *
 * `details` в контракте — свободная структура (`unknown`), поэтому приводим её к
 * строке через `JSON.stringify` и подставляем как текст. Пытаться угадать схему
 * значило бы показать `[object Object]` или упасть на неожиданном значении.
 */
function AuditDetails({ details }: { details: unknown }) {
  if (details === null || details === undefined) {
    return <span className="text-xs text-slate-500">—</span>;
  }

  let text: string;
  try {
    text = typeof details === "string" ? details : JSON.stringify(details);
  } catch {
    // Циклическая структура в `details` не должна ронять страницу журнала.
    text = "не удалось показать";
  }

  return (
    <code className="block max-w-80 truncate text-xs text-slate-700" title={text}>
      {text}
    </code>
  );
}