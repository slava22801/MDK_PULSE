import type { InputHTMLAttributes, ReactNode } from "react";

type FormFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  id: string;
  label: string;
  /** Сообщение под полем: ошибка клиентской или серверной валидации. */
  error?: string | undefined;
  /** Подсказка об ограничениях — нужна, чтобы не вываливать правила текстом. */
  hint?: ReactNode;
};

/**
 * Поле формы с обязательной связкой label/input через htmlFor + id:
 * без неё клик по подписи не фокусирует поле и скринридер читает ввод без имени.
 *
 * `...inputProps` сюда кладутся из `register()` react-hook-form, поэтому компонент
 * остаётся тонкой обёрткой и не знает про RHF.
 */
export function FormField({ id, label, error, hint, className, ...inputProps }: FormFieldProps) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={[
          "w-full rounded-xl border bg-white px-3.5 py-2.5 text-base text-slate-900",
          "placeholder:text-slate-400 disabled:cursor-not-allowed",
          error ? "border-rose-400" : "border-slate-300",
          className ?? "",
        ].join(" ")}
        {...inputProps}
      />
      {hint ? (
        <p id={hintId} className="text-xs leading-relaxed text-slate-500">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-sm font-medium text-rose-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}