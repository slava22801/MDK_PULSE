import { data, Form, useActionData, useNavigation, useSearchParams } from "react-router";

import type { Route } from "./+types/promocodes";

import type { AdminPage, PromoCheckResponse, PromoCodeOut } from "~/lib/admin";
import type { ApiErrorInfo } from "~/lib/api-error";
import { describeApiError } from "~/lib/api-error";
import { serverFetch } from "~/lib/api.server";
import type { AdminAccess } from "~/lib/admin.server";
import { requireAdminSession } from "~/lib/admin.server";
import {
  DISCOUNT_TYPE_LABEL,
  formatDateTime,
  fromDateTimeLocal,
  parseLimit,
  parsePage,
  toDateTimeLocal,
} from "~/lib/admin";
import { formatPrice } from "~/lib/format";
import {
  ADMIN_INPUT,
  ActionButton,
  AdminCell,
  AdminField,
  AdminNotice,
  AdminPagination,
  AdminTable,
  AdminTextarea,
  EmptyState,
  LoadError,
  StatusBadge,
} from "~/widgets/admin-ui";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Промокоды — Админ-панель — ПУЛЬС" }];
}

/**
 * Промокоды: список, создание, правка, удаление, проверка на сумме.
 *
 * CRUD — только администратор; проверять промокод на сумме может и менеджер
 * (`POST /admin/promocodes/check` живёт под общей ролью сотрудника — проверено
 * живым запросом от имени manager). Поэтому форма проверки вынесена вниз и
 * доступна обеим ролям, а `action` проверяет роль по intent, а не по странице.
 */

type PromoActionResult = {
  ok?: string;
  error?: string;
  errorCode?: string;
  fields?: Record<string, string>;
  /** Ответ проверки промокода — показываем как есть, вместе с расчётом скидки. */
  check?: PromoCheckResponse;
  /** Возвращаем правку, чтобы форма не закрылась после ошибки. */
  edit?: string;
};

const DISCOUNT_TYPES = Object.keys(DISCOUNT_TYPE_LABEL);

export async function loader({ request }: Route.LoaderArgs) {
  // Раздел открыт обеим ролям, но не одинаково: менеджеру сервер отдаёт 403 на
  // список промокодов (живая проверка), зато разрешает проверку кода. Поэтому
  // роль решается здесь, а не в разметке: менеджеру показываем только форму
  // проверки, администратору — полный CRUD.
  const session = await requireAdminSession(request, { roles: ["manager", "admin"] });
  const canEdit = session.user.role === "admin";

  if (!canEdit) {
    return { canEdit, promos: null, error: null };
  }

  const url = new URL(request.url);
  const page = parsePage(url.searchParams.get("page"));
  const limit = parseLimit(url.searchParams.get("limit"));

  const list = await serverFetch<AdminPage<PromoCodeOut>>(`/admin/promocodes?page=${page}&limit=${limit}`, {
    headers: session.headers,
  }).catch((cause: unknown) => cause as ApiErrorInfo);

  const error = list instanceof Error ? describeApiError(list, "Не удалось загрузить промокоды") : null;

  return {
    canEdit,
    promos: error ? null : (list as AdminPage<PromoCodeOut>),
    error,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const field = (name: string): string => String(form.get(name) ?? "").trim();

  // Проверка промокода — операция менеджера: её роль отличается от CRUD.
  // Тип `AdminAccess` указан явно, иначе TypeScript не поймёт объединение
  // `{section}` / `{roles}` и потребует лишнего приведения типа.
  const access: AdminAccess = intent === "check" ? { roles: ["manager", "admin"] } : { section: "promocodes" };
  const session = await requireAdminSession(request, access);

  try {
    if (intent === "check") {
      const code = field("code");
      if (!code) {
        return data<PromoActionResult>({ error: "Введите промокод", errorCode: "code_required" }, { status: 400 });
      }
      const check = await serverFetch<PromoCheckResponse>("/admin/promocodes/check", {
        method: "POST",
        headers: session.jsonHeaders,
        // Сумма приходит строкой: backend принимает `number | str` (Decimal).
        body: JSON.stringify({ code, total: field("total") || "0" }),
      });
      return data<PromoActionResult>({ ok: check.message, check }, { status: 200 });
    }

    if (intent === "create") {
      const created = await serverFetch<PromoCodeOut>("/admin/promocodes", {
        method: "POST",
        headers: session.jsonHeaders,
        body: JSON.stringify(buildPromoPayload(form, true)),
      });
      return data<PromoActionResult>({ ok: `Промокод ${created.code} создан` }, { status: 200 });
    }

    if (intent === "update" || intent === "toggle") {
      const promoId = field("promo_id");
      if (!promoId) {
        return data<PromoActionResult>({ error: "Не указан промокод" }, { status: 400 });
      }

      if (intent === "toggle") {
        // Тумблер активности — минимальное изменение: пересылаем только флаг,
        // чтобы не затереть остальные поля значениями из неполной формы.
        await serverFetch(`/admin/promocodes/${encodeURIComponent(promoId)}`, {
          method: "PATCH",
          headers: session.jsonHeaders,
          body: JSON.stringify({ is_active: field("is_active") === "true" }),
        });
        return data<PromoActionResult>({ ok: "Активность обновлена" }, { status: 200 });
      }

      await serverFetch(`/admin/promocodes/${encodeURIComponent(promoId)}`, {
        method: "PATCH",
        headers: session.jsonHeaders,
        body: JSON.stringify(buildPromoPayload(form, false)),
      });
      return data<PromoActionResult>({ ok: "Промокод сохранён", edit: promoId }, { status: 200 });
    }

    if (intent === "delete") {
      const promoId = field("promo_id");
      if (!promoId) {
        return data<PromoActionResult>({ error: "Не указан промокод" }, { status: 400 });
      }
      await serverFetch(`/admin/promocodes/${encodeURIComponent(promoId)}`, {
        method: "DELETE",
        headers: session.headers,
      });
      return data<PromoActionResult>({ ok: "Промокод удалён" }, { status: 200 });
    }

    return data<PromoActionResult>({ error: "Неизвестное действие" }, { status: 400 });
  } catch (cause) {
    const info = describeApiError(cause, "Не удалось выполнить действие с промокодом");
    return data<PromoActionResult>(
      {
        error: promoErrorMessage(info),
        errorCode: info.code,
        fields: info.fields,
        edit: intent === "delete" || intent === "check" ? "" : field("promo_id"),
      },
      { status: info.status >= 400 && info.status < 500 ? info.status : 400 },
    );
  }
}

/**
 * Тело промокода для POST/PATCH.
 *
 * Числа шлём строками: схема допускает `number | str` (Decimal), и так суммы не
 * теряют точность. Пустые необязательные поля в PATCH не отправляем — иначе
 * пустая строка затёрла бы заданное значение.
 */
function buildPromoPayload(form: FormData, creating: boolean): Record<string, unknown> {
  const field = (name: string): string => String(form.get(name) ?? "").trim();

  const payload: Record<string, unknown> = {
    code: field("code"),
    discount_type: field("discount_type"),
    discount_value: field("discount_value"),
    valid_from: fromDateTimeLocal(field("valid_from")),
    valid_to: fromDateTimeLocal(field("valid_to")),
  };

  if (!creating) {
    // `code` в PATCH не меняется: менять промокод после использований нельзя,
    // иначе клиенты с сохранённым кодом потеряли бы скидку.
    delete payload.code;
  }

  const optional: Record<string, string> = {
    description: field("description"),
    min_order_amount: field("min_order_amount"),
    max_discount_amount: field("max_discount_amount"),
    usage_limit: field("usage_limit"),
    usage_limit_per_user: field("usage_limit_per_user"),
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== "") payload[key] = value;
  }

  if (creating) payload.is_active = form.get("is_active") !== null;

  return payload;
}

function promoErrorMessage(info: ApiErrorInfo): string {
  switch (info.code) {
    case "promo_code_exists":
      return info.message;
    case "insufficient_role":
      return "Управление промокодами доступно только администратору.";
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

export default function AdminPromocodes({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>() as PromoActionResult | undefined;
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const { canEdit, promos, error } = loaderData;

  const busy = navigation.state !== "idle";
  const currentSearch = new URLSearchParams(searchParams);

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Промокоды</h1>
          <p className="mt-1 text-sm text-slate-600">
            Скидки фиксированной суммой, в процентах и на бесплатную доставку.
            {canEdit ? "" : " Создание и правка доступны только администратору."}
          </p>
        </div>
      </div>

      <AdminNotice ok={actionData?.ok} error={actionData?.error} errorCode={actionData?.errorCode} />

      {canEdit ? (
        <section aria-labelledby="promo-create" className="card mt-5 p-5">
          <h2 id="promo-create" className="text-lg font-semibold text-slate-900">
            Новый промокод
          </h2>
          <PromoForm
            key="create"
            intent="create"
            fields={actionData?.fields ?? {}}
            busy={busy}
            submitLabel="Создать промокод"
          />
        </section>
      ) : null}

      {/* Список и CRUD — только администратору: менеджеру сервер отдаёт на
          `GET /admin/promocodes` 403, и показывать ему «пусто» значило бы
          врать, что промокодов нет. */}
      {!canEdit ? null : error ? (
        <div className="mt-5">
          <LoadError error={error} />
        </div>
      ) : promos && promos.items.length > 0 ? (
        <>
          <AdminTable
            caption="Список промокодов"
            headers={["Код", "Скидка", "Условия", "Действует", "Использований", "Статус", canEdit ? "Действия" : ""].filter(
              (header) => header !== "",
            )}
          >
            {promos.items.map((promo) => (
              <tr key={promo.id} className="align-top hover:bg-slate-50">
                <AdminCell nowrap>
                  <span className="font-semibold text-slate-900">{promo.code}</span>
                  {promo.description ? (
                    <p className="mt-0.5 text-xs text-slate-600">{promo.description}</p>
                  ) : null}
                </AdminCell>
                <AdminCell nowrap>
                  <p className="text-sm text-slate-900">
                    {DISCOUNT_TYPE_LABEL[promo.discount_type] ?? promo.discount_type}
                  </p>
                  <p className="text-xs text-slate-600">
                    {promo.discount_type === "percent" ? `${promo.discount_value}%` : formatPrice(promo.discount_value)}
                  </p>
                </AdminCell>
                <AdminCell nowrap>
                  <p className="text-xs text-slate-700">От {formatPrice(promo.min_order_amount)}</p>
                  {promo.max_discount_amount ? (
                    <p className="text-xs text-slate-700">
                      Макс. {formatPrice(promo.max_discount_amount)}
                    </p>
                  ) : null}
                  {promo.usage_limit ? (
                    <p className="text-xs text-slate-700">Лимит: {promo.usage_limit}</p>
                  ) : null}
                </AdminCell>
                <AdminCell nowrap>
                  <p className="text-xs text-slate-700">с {formatDateTime(promo.valid_from)}</p>
                  <p className="text-xs text-slate-700">по {formatDateTime(promo.valid_to)}</p>
                </AdminCell>
                <AdminCell nowrap>{promo.used_count}</AdminCell>
                <AdminCell nowrap>
                  <StatusBadge
                    label={promo.is_active ? "Активен" : "Выключен"}
                    tone={promo.is_active ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-700"}
                  />
                </AdminCell>
                {canEdit ? (
                  <AdminCell nowrap>
                    <div className="flex flex-wrap gap-2">
                      <Form method="post">
                        <input type="hidden" name="intent" value="toggle" />
                        <input type="hidden" name="promo_id" value={promo.id} />
                        <input type="hidden" name="is_active" value={promo.is_active ? "false" : "true"} />
                        <ActionButton intent="toggle" busy={busy} busyLabel="…">
                          {promo.is_active ? "Выключить" : "Включить"}
                        </ActionButton>
                      </Form>

                      <Form
                        method="post"
                        onSubmit={(event) => {
                          if (
                            typeof window !== "undefined" &&
                            !window.confirm(`Удалить промокод ${promo.code}?`)
                          ) {
                            event.preventDefault();
                          }
                        }}
                      >
                        <input type="hidden" name="intent" value="delete" />
                        <input type="hidden" name="promo_id" value={promo.id} />
                        <ActionButton intent="delete" tone="danger" busy={busy} busyLabel="Удаляем…">
                          Удалить
                        </ActionButton>
                      </Form>
                    </div>
                  </AdminCell>
                ) : null}
              </tr>
            ))}
          </AdminTable>

          <AdminPagination
            pathname="/admin/promocodes"
            search={currentSearch}
            page={promos.page}
            pages={promos.pages}
            total={promos.total}
          />
        </>
      ) : (
        <div className="mt-5">
          <EmptyState title="Промокодов пока нет" hint="Создайте первый промокод формой выше." />
        </div>
      )}

      <PromoCheckForm actionData={actionData} busy={busy} />
    </>
  );
}

/**
 * Проверка промокода на сумме.
 *
 * Отдельная форма внизу страницы: она доступна и менеджеру, который не имеет
 * прав на CRUD, — ровно как на сервере (`/admin/promocodes/check` открыт обеим
 * ролям).
 */
function PromoCheckForm({ actionData, busy }: { actionData?: PromoActionResult; busy: boolean }) {
  const check = actionData?.check;

  return (
    <section aria-labelledby="promo-check" className="card mt-8 p-5">
      <h2 id="promo-check" className="text-lg font-semibold text-slate-900">
        Проверить промокод
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        Показывает, сработает ли код на указанной сумме и какую скидку даст.
      </p>

      <Form method="post" className="mt-4 grid gap-4 sm:grid-cols-3 sm:items-end">
        <input type="hidden" name="intent" value="check" />

        <AdminField id="check-code" label="Промокод" required>
          <input id="check-code" name="code" maxLength={50} required className={ADMIN_INPUT} />
        </AdminField>

        <AdminField id="check-total" label="Сумма заказа, ₽" required>
          <input
            id="check-total"
            name="total"
            type="number"
            min={0}
            step="0.01"
            defaultValue="10000"
            required
            className={ADMIN_INPUT}
          />
        </AdminField>

        <div>
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-xl bg-pulse-600 px-4 py-2 text-sm font-semibold text-white hover:bg-pulse-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Проверяем…" : "Проверить"}
          </button>
        </div>
      </Form>

      {check ? (
        <div
          role="status"
          className={`mt-4 rounded-xl border px-4 py-3 text-sm ${
            check.valid
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-amber-300 bg-amber-50 text-amber-900"
          }`}
        >
          <p className="font-medium">{check.message}</p>
          {check.valid ? (
            <p className="mt-1">
              Скидка: <span className="font-semibold">{formatPrice(check.discount_amount)}</span>
              {check.promo_code ? ` по промокоду ${check.promo_code}` : ""}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** Форма создания/правки промокода. */
function PromoForm({
  intent,
  promo,
  fields,
  busy,
  submitLabel,
}: {
  intent: "create" | "update";
  promo?: PromoCodeOut;
  fields: Record<string, string>;
  busy: boolean;
  submitLabel: string;
}) {
  return (
    <Form method="post" className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <input type="hidden" name="intent" value={intent} />
      {promo ? <input type="hidden" name="promo_id" value={promo.id} /> : null}

      <AdminField
        id={`promo-code-${intent}`}
        label="Код"
        error={fields.code}
        required
        hint={promo ? "Код после создания не меняется." : "Латиницей, например SUMMER10."}
      >
        <input
          id={`promo-code-${intent}`}
          name="code"
          defaultValue={promo?.code ?? ""}
          maxLength={50}
          minLength={3}
          required
          readOnly={Boolean(promo)}
          className={`${ADMIN_INPUT} ${fields.code ? "border-rose-400" : ""}`}
        />
      </AdminField>

      <AdminField id={`promo-type-${intent}`} label="Тип скидки" error={fields.discount_type} required>
        <select
          id={`promo-type-${intent}`}
          name="discount_type"
          defaultValue={promo?.discount_type ?? "percent"}
          className={ADMIN_INPUT}
        >
          {DISCOUNT_TYPES.map((value) => (
            <option key={value} value={value}>
              {DISCOUNT_TYPE_LABEL[value] ?? value}
            </option>
          ))}
        </select>
      </AdminField>

      <AdminField
        id={`promo-value-${intent}`}
        label="Размер скидки"
        error={fields.discount_value}
        required
        hint="Проценты для «Процент», сумма в рублях для остальных."
      >
        <input
          id={`promo-value-${intent}`}
          name="discount_value"
          type="number"
          min={0}
          step="0.01"
          defaultValue={promo?.discount_value ?? ""}
          required
          className={`${ADMIN_INPUT} ${fields.discount_value ? "border-rose-400" : ""}`}
        />
      </AdminField>

      <AdminField id={`promo-min-${intent}`} label="Минимальная сумма заказа, ₽" error={fields.min_order_amount}>
        <input
          id={`promo-min-${intent}`}
          name="min_order_amount"
          type="number"
          min={0}
          step="0.01"
          defaultValue={promo?.min_order_amount ?? ""}
          className={ADMIN_INPUT}
        />
      </AdminField>

      <AdminField
        id={`promo-max-${intent}`}
        label="Максимальная скидка, ₽"
        error={fields.max_discount_amount}
        hint="Пусто — без ограничения."
      >
        <input
          id={`promo-max-${intent}`}
          name="max_discount_amount"
          type="number"
          min={0}
          step="0.01"
          defaultValue={promo?.max_discount_amount ?? ""}
          className={ADMIN_INPUT}
        />
      </AdminField>

      <AdminField id={`promo-limit-${intent}`} label="Всего применений" error={fields.usage_limit}>
        <input
          id={`promo-limit-${intent}`}
          name="usage_limit"
          type="number"
          min={1}
          step={1}
          defaultValue={promo?.usage_limit ? String(promo.usage_limit) : ""}
          className={ADMIN_INPUT}
        />
      </AdminField>

      <AdminField
        id={`promo-per-user-${intent}`}
        label="Применений на одного покупателя"
        error={fields.usage_limit_per_user}
      >
        <input
          id={`promo-per-user-${intent}`}
          name="usage_limit_per_user"
          type="number"
          min={1}
          step={1}
          defaultValue={promo?.usage_limit_per_user ? String(promo.usage_limit_per_user) : ""}
          className={ADMIN_INPUT}
        />
      </AdminField>

      <AdminField id={`promo-from-${intent}`} label="Действует с" error={fields.valid_from} required>
        <input
          id={`promo-from-${intent}`}
          name="valid_from"
          type="datetime-local"
          defaultValue={toDateTimeLocal(promo?.valid_from ?? null)}
          required
          className={ADMIN_INPUT}
        />
      </AdminField>

      <AdminField id={`promo-to-${intent}`} label="Действует по" error={fields.valid_to} required>
        <input
          id={`promo-to-${intent}`}
          name="valid_to"
          type="datetime-local"
          defaultValue={toDateTimeLocal(promo?.valid_to ?? null)}
          required
          className={ADMIN_INPUT}
        />
      </AdminField>

      {intent === "create" ? (
        <div className="flex items-center gap-2 sm:col-span-2 lg:col-span-3">
          <input
            id={`promo-active-${intent}`}
            name="is_active"
            type="checkbox"
            defaultChecked
            className="h-4 w-4 rounded border-slate-300"
          />
          <label htmlFor={`promo-active-${intent}`} className="text-sm text-slate-800">
            Промокод активен
          </label>
        </div>
      ) : null}

      <div className="sm:col-span-2 lg:col-span-3">
        <AdminField id={`promo-desc-${intent}`} label="Описание" error={fields.description}>
          <AdminTextarea
            id={`promo-desc-${intent}`}
            name="description"
            rows={2}
            maxLength={300}
            defaultValue={promo?.description ?? ""}
            placeholder="Для чего этот промокод"
          />
        </AdminField>
      </div>

      <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-3">
        <ActionButton intent={intent} tone="primary" busy={busy} busyLabel="Сохраняем…">
          {submitLabel}
        </ActionButton>
      </div>
    </Form>
  );
}