import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { queryClient } from "@/client/tanstack-db";
import { useSession } from "@/client/hooks/useSession";
import { useCloseModalOnEscape } from "@/client/hooks/useCloseModalOnEscape";
import { createUserApp } from "@/serverFunctions/user-apps";

const addCustomAppSchema = z.object({
  appId: z
    .string()
    .min(1, "App ID is required")
    .max(50, "App ID too long")
    .regex(
      /^[a-z0-9-]+$/,
      "App ID must contain only lowercase letters, numbers, and hyphens",
    ),
  name: z.string().min(1, "App name is required").max(255, "App name too long"),
  description: z
    .string()
    .min(1, "Description is required")
    .max(1000, "Description too long"),
  appUrl: z.string().url("Please enter a valid URL"),
});

type AddCustomAppFormData = z.infer<typeof addCustomAppSchema>;

interface AddCustomAppModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddCustomAppModal({
  open,
  onOpenChange,
}: AddCustomAppModalProps) {
  const { data: session } = useSession();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<AddCustomAppFormData>({
    resolver: zodResolver(addCustomAppSchema),
    defaultValues: {
      appId: "",
      name: "",
      description: "",
      appUrl: "",
    },
  });

  const onSubmit = async (data: AddCustomAppFormData) => {
    if (!session?.user?.id) return;

    setSubmitError(null);
    setIsSubmitting(true);

    try {
      const result = await createUserApp({ data });

      if (result.success) {
        // Invalidate and refetch the user apps collection
        await queryClient.invalidateQueries({ queryKey: ["user-apps"] });
        onOpenChange(false);
        form.reset();
      }
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("already exists")) {
          setSubmitError(
            "You already have an app with this App ID. Please choose a different App ID.",
          );
        } else {
          setSubmitError(error.message);
        }
      } else {
        setSubmitError("An unexpected error occurred. Please try again.");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    onOpenChange(false);
    form.reset();
    setSubmitError(null);
  };

  // Handle Escape key to close modal
  useCloseModalOnEscape(open, handleClose);

  const {
    register,
    formState: { errors },
  } = form;

  return (
    <dialog className={`modal ${open ? "modal-open" : ""}`}>
      <div className="modal-box">
        <h3 className="font-bold text-lg">Add App</h3>
        <p>Create an entry for your application</p>

        <form onSubmit={form.handleSubmit(onSubmit)}>
          <div className="form-control">
            <label className="label">
              <span className="label-text">App ID</span>
            </label>
            <input
              type="text"
              placeholder="my-custom-app"
              className="input input-bordered w-full"
              {...register("appId")}
            />
            {errors.appId && (
              <label className="label">
                <span className="label-text-alt text-error">
                  {errors.appId.message}
                </span>
              </label>
            )}
          </div>

          <div className="form-control">
            <label className="label">
              <span className="label-text">App Name</span>
            </label>
            <input
              type="text"
              placeholder="My Custom App"
              className="input input-bordered w-full"
              {...register("name")}
            />
            {errors.name && (
              <label className="label">
                <span className="label-text-alt text-error">
                  {errors.name.message}
                </span>
              </label>
            )}
          </div>

          <div className="form-control">
            <label className="label">
              <span className="label-text">Description</span>
            </label>
            <textarea
              placeholder="Describe what your app does..."
              className="textarea textarea-bordered w-full"
              rows={3}
              {...register("description")}
            />
            {errors.description && (
              <label className="label">
                <span className="label-text-alt text-error">
                  {errors.description.message}
                </span>
              </label>
            )}
          </div>

          <div className="form-control">
            <label className="label">
              <span className="label-text">App URL</span>
            </label>
            <input
              type="text"
              placeholder="https://your-app.example.com"
              className="input input-bordered w-full"
              {...register("appUrl")}
            />
            {errors.appUrl && (
              <label className="label">
                <span className="label-text-alt text-error">
                  {errors.appUrl.message}
                </span>
              </label>
            )}
          </div>

          {submitError && (
            <div className="alert alert-error mt-4">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="stroke-current shrink-0 h-6 w-6"
                fill="none"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <span>{submitError}</span>
            </div>
          )}

          <div className="modal-action">
            <button
              type="button"
              className="btn btn-outline"
              onClick={handleClose}
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <span className="loading loading-spinner loading-sm"></span>
                  Adding...
                </>
              ) : (
                "Add"
              )}
            </button>
          </div>
        </form>
      </div>
      <form method="dialog" className="modal-backdrop" onClick={handleClose}>
        <button type="button">close</button>
      </form>
    </dialog>
  );
}
