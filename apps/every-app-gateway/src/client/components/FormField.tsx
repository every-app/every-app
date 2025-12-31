import type { FieldError, UseFormRegisterReturn } from "react-hook-form";

interface FormFieldProps {
  label: string;
  placeholder?: string;
  error?: FieldError;
  registration: UseFormRegisterReturn;
  type?: "text" | "textarea";
  rows?: number;
}

/**
 * Reusable form field component with consistent styling and error handling.
 * Supports both text inputs and textareas.
 */
export function FormField({
  label,
  placeholder,
  error,
  registration,
  type = "text",
  rows = 3,
}: FormFieldProps) {
  return (
    <div className="form-control">
      <label className="label">
        <span className="label-text">{label}</span>
      </label>
      {type === "textarea" ? (
        <textarea
          placeholder={placeholder}
          className="textarea textarea-bordered w-full"
          rows={rows}
          {...registration}
        />
      ) : (
        <input
          type="text"
          placeholder={placeholder}
          className="input input-bordered w-full"
          {...registration}
        />
      )}
      {error && (
        <label className="label">
          <span className="label-text-alt text-error">{error.message}</span>
        </label>
      )}
    </div>
  );
}

interface DisabledFieldProps {
  label: string;
  value: string;
}

/**
 * A read-only form field for displaying non-editable values.
 */
export function DisabledField({ label, value }: DisabledFieldProps) {
  return (
    <div className="form-control">
      <label className="label">
        <span className="label-text">{label}</span>
      </label>
      <input
        type="text"
        className="input input-bordered w-full"
        value={value}
        disabled
      />
    </div>
  );
}
