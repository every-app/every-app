import type { FieldError, UseFormRegisterReturn } from "react-hook-form";
import { DEFAULT_DEV_URL } from "@/schemas/user-app";

interface DevModeFormSectionProps {
  devUrl: string | null | undefined;
  onToggle: (enabled: boolean) => void;
  registration: UseFormRegisterReturn;
  error?: FieldError;
}

/**
 * Reusable form section for configuring development mode URL.
 * Used in both AddCustomAppModal and EditAppModal.
 *
 * The parent component controls the devUrl value and toggle behavior,
 * keeping this component simple and framework-agnostic.
 */
export function DevModeFormSection({
  devUrl,
  onToggle,
  registration,
  error,
}: DevModeFormSectionProps) {
  const hasDevMode = !!devUrl;

  return (
    <>
      <div className="form-control">
        <label className="label">
          <span className="label-text">Development Mode</span>
        </label>
        <p className="text-sm text-base-content/60 mb-2">
          Enable to test with a local development server instead of the
          production URL.
        </p>
        <input
          type="checkbox"
          className="toggle toggle-primary"
          checked={hasDevMode}
          onChange={(e) => onToggle(e.target.checked)}
        />
      </div>

      {hasDevMode && (
        <div className="form-control">
          <label className="label">
            <span className="label-text">Dev URL</span>
          </label>
          <input
            type="text"
            placeholder={DEFAULT_DEV_URL}
            className="input input-bordered w-full"
            {...registration}
          />
          {error && (
            <label className="label">
              <span className="label-text-alt text-error">{error.message}</span>
            </label>
          )}
        </div>
      )}
    </>
  );
}
