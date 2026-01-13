import type { FieldError, UseFormRegisterReturn } from "react-hook-form";

interface FormFieldProps {
  label: string;
  description?: string;
  placeholder?: string;
  error?: FieldError;
  registration: UseFormRegisterReturn;
  type?: "text" | "textarea";
  rows?: number;
  onBlur?: (
    e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => void;
}

/**
 * Reusable form field component with consistent styling and error handling.
 * Supports both text inputs and textareas.
 */
export function FormField({
  label,
  description,
  placeholder,
  error,
  registration,
  type = "text",
  rows = 3,
  onBlur,
}: FormFieldProps) {
  const handleBlur = (
    e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    registration.onBlur(e);
    onBlur?.(e);
  };
  return (
    <div className="form-control">
      <label className="label pb-0">
        <span className="label-text">{label}</span>
      </label>
      {description && (
        <span className="text-xs text-base-content/60 px-1 pb-1">
          {description}
        </span>
      )}
      {type === "textarea" ? (
        <textarea
          placeholder={placeholder}
          className="textarea textarea-bordered w-full"
          rows={rows}
          {...registration}
          onBlur={handleBlur}
        />
      ) : (
        <input
          type="text"
          placeholder={placeholder}
          className="input input-bordered w-full"
          {...registration}
          onBlur={handleBlur}
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
