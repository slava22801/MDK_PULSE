import { data, Form, useNavigation } from "react-router";

import type { Route } from "./+types/import";

import type { ImportReport } from "~/lib/admin";
import type { ApiErrorInfo } from "~/lib/api-error";
import { describeApiError } from "~/lib/api-error";
import { serverFetch } from "~/lib/api.server";
import { requireAdminSession } from "~/lib/admin.server";
import { ADMIN_INPUT, AdminCell, AdminField, AdminNotice, AdminPageHeader, AdminTable } from "~/widgets/admin-ui";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Импорт товаров — Админ-панель — ПУЛЬС" }];
}

/**
 * Импорт товаров из CSV/XLSX.
 *
 * Раздел только для администратора — он меняет каталог целиком.
 *
 * Отдельная страница, а не часть `/admin/products`: у формы файла принципиально
 * другой способ отправки (`multipart/form-data`), и смешивать её с полями
 * товара значило бы отправлять файл вместе с любыми правками карточки.
 *
 * `enctype="multipart/form-data"` обязателен: без него браузер отправит файл
 * как строку, и backend не сможет его разобрать.
 */

type ImportActionResult = {
  ok?: string;
  error?: string;
  errorCode?: string;
  /** Отчёт показываем сразу после действия, без перезагрузки списка. */
  report?: ImportReport;
  /** `false` — файл был проверен, но не применён (dry run). */
  dryRun?: boolean;
};

export async function loader({ request }: Route.LoaderArgs) {
  // Роль проверяем на входе: раздел меняет каталог, гостю и менеджеру он не нужен.
  await requireAdminSession(request, { section: "products" });
  return { open: true };
}

export async function action({ request }: Route.ActionArgs) {
  const session = await requireAdminSession(request, { section: "products" });

  const form = await request.formData();
  // Чекбокс снят → true: проверяем без записи. Так безопасное поведение
  // совпадает с состоянием «по умолчанию», а не наоборот.
  const dryRun = form.get("dry_run") !== "false";
  const file = form.get("file");

  if (!(file instanceof File) || file.size === 0) {
    return data<ImportActionResult>(
      { error: "Выберите файл CSV или XLSX", errorCode: "file_required" },
      { status: 400 },
    );
  }

  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension !== "csv" && extension !== "xlsx") {
    return data<ImportActionResult>(
      { error: "Поддерживаются только файлы .csv и .xlsx", errorCode: "unsupported_format" },
      { status: 400 },
    );
  }

  // Отдельный FormData: заголовок `Content-Type` с boundary выставляет сам
  // fetch, поэтому jsonHeaders здесь не годится — он бы сломал разбор файла.
  const body = new FormData();
  body.set("file", file);
  body.set("dry_run", dryRun ? "true" : "false");

  try {
    const report = await serverFetch<ImportReport>("/admin/products/import", {
      method: "POST",
      headers: session.headers,
      body,
    });

    return data<ImportActionResult>(
      {
        ok: dryRun
          ? "Файл проверен, данные не изменены"
          : "Файл загружен, товары созданы и обновлены",
        report,
        dryRun,
      },
      { status: 200 },
    );
  } catch (cause) {
    const info = describeApiError(cause, "Не удалось загрузить файл");
    return data<ImportActionResult>(
      { error: importErrorMessage(info), errorCode: info.code },
      { status: info.status >= 400 && info.status < 500 ? info.status : 400 },
    );
  }
}

function importErrorMessage(info: ApiErrorInfo): string {
  switch (info.code) {
    case "validation_error":
    // Тексты сервера показываем как есть: `missing_columns` перечисляет
    // отсутствующие колонки, а `unsupported_format` — полученное расширение.
    // Своя формулировка потеряла бы ровно ту деталь, ради которой её читают.
    case "missing_columns":
    case "unsupported_format":
    case "empty_file":
      return info.message;
    case "insufficient_role":
      return "Импорт доступен только администратору.";
    case "network_error":
      return "Сервер недоступен. Проверьте соединение и повторите загрузку.";
    default:
      return info.status >= 500
        ? "Сервер временно недоступен, файл не загружен."
        : info.message;
  }
}

export default function AdminImport({ actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  // Загрузка файла идёт долго: без индикации сотрудник решит, что форма зависла,
  // и нажмёт «Отправить» ещё раз.
  const busy = navigation.state !== "idle";

  return (
    <>
      <AdminPageHeader
        title="Импорт товаров"
        description="Загрузка каталога из CSV или XLSX. Сначала проверьте файл без записи."
        actions={
          <a
            href="/admin/products"
            className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            К списку товаров
          </a>
        }
      />

      <AdminNotice ok={actionData?.ok} error={actionData?.error} errorCode={actionData?.errorCode} />

      <Form
        method="post"
        encType="multipart/form-data"
        className="card mt-5 grid gap-4 p-5 sm:grid-cols-2"
      >
        <AdminField
          id="import-file"
          label="Файл каталога"
          required
          hint={
            <>
              Обязательные колонки: <code>Артикул; Название; Категория; Бренд; Цена; Количество</code>.
              Разделитель — «;», цена принимается и «54 990,00», и «54990».
            </>
          }
        >
          <input
            id="import-file"
            name="file"
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            required
            className={`${ADMIN_INPUT} file:me-2 file:rounded-lg file:border-0 file:bg-slate-100 file:px-2 file:py-1 file:text-xs`}
          />
        </AdminField>

        <div className="flex items-center gap-2 sm:items-end">
          <input
            id="import-dry-run"
            name="dry_run"
            type="checkbox"
            value="false"
            defaultChecked
            className="h-4 w-4 rounded border-slate-300"
          />
          <label htmlFor="import-dry-run" className="text-sm text-slate-800">
            Только проверить, без записи в каталог
          </label>
        </div>

        <div className="sm:col-span-2">
          <button
            type="submit"
            disabled={busy}
            className="rounded-xl bg-pulse-600 px-4 py-2 text-sm font-semibold text-white hover:bg-pulse-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Загружаем…" : "Загрузить файл"}
          </button>
        </div>
      </Form>

      {actionData?.report ? (
        <ImportReportView report={actionData.report} dryRun={actionData.dryRun} />
      ) : (
        // Подсказка по формату файла видна и до первой загрузки: без неё
        // сотрудник узнает о неверных колонках только после отправки.
        <p className="mt-4 text-sm text-slate-600">
          В отчёте каждая ошибка указана с номером строки и столбца — исправьте их в файле и загрузите снова.
        </p>
      )}
    </>
  );
}

/** Отчёт импорта: сводные числа и построчный список ошибок. */
function ImportReportView({ report, dryRun }: { report: ImportReport; dryRun?: boolean }) {
  return (
    <section aria-labelledby="import-report" className="mt-8">
      <h2 id="import-report" className="text-lg font-semibold text-slate-900">
        Отчёт {dryRun ? "проверки" : "загрузки"}
      </h2>
      {report.message ? <p className="mt-1 text-sm text-slate-600">{report.message}</p> : null}

      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <ReportCard label="Строк в файле" value={report.total_rows} />
        <ReportCard label="Создано" value={report.created} />
        <ReportCard label="Обновлено" value={report.updated} />
        <ReportCard label="Пропущено" value={report.skipped} />
        <ReportCard label="Ошибок" value={report.errors.length} tone={report.errors.length > 0 ? "warn" : "ok"} />
      </dl>

      {report.errors.length > 0 ? (
        <AdminTable
          caption="Ошибки импорта по строкам"
          headers={["Строка", "Столбец", "Причина"]}
        >
          {report.errors.map((row, index) => (
            <tr key={`${row.row_number}-${index}`}>
              <AdminCell nowrap>{row.row_number}</AdminCell>
              <AdminCell nowrap>
                <span className="text-slate-600">{row.column ?? "—"}</span>
              </AdminCell>
              <AdminCell>{row.message}</AdminCell>
            </tr>
          ))}
        </AdminTable>
      ) : (
        <p className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Ошибок нет — все строки разобраны.
        </p>
      )}
    </section>
  );
}

/** Плитка одного показателя отчёта. */
function ReportCard({
  label,
  value,
  tone = "plain",
}: {
  label: string;
  value: number;
  tone?: "plain" | "ok" | "warn";
}) {
  const tones: Record<string, string> = {
    plain: "border-slate-200 bg-white",
    ok: "border-emerald-200 bg-emerald-50",
    warn: "border-amber-300 bg-amber-50",
  };

  return (
    <div className={`rounded-xl border px-3 py-2 ${tones[tone] ?? tones.plain}`}>
      <dt className="text-xs text-slate-600">{label}</dt>
      <dd className="mt-0.5 text-lg font-bold text-slate-900">{value}</dd>
    </div>
  );
}