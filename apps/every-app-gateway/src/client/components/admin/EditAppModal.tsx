import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Modal } from "../Modal";
import { FormField } from "../FormField";
import { DevModeFormSection } from "../DevModeFormSection";
import { adminAppsCollection } from "@/client/tanstack-db";
import { editAppSchema, type EditAppFormData } from "@/schemas/app";
import { DEFAULT_DEV_URL } from "@/schemas/user-app";
import type { AppWithAccessCount } from "@/types/app";

interface EditAppModalProps {
  open: boolean;
  onClose: () => void;
  app: AppWithAccessCount | null;
}

export function EditAppModal({ open, onClose, app }: EditAppModalProps) {
  const [isPending, setIsPending] = useState(false);

  const form = useForm<EditAppFormData>({
    resolver: zodResolver(editAppSchema),
    defaultValues: {
      name: "",
      description: "",
      appUrl: "",
      devUrl: null,
      isDefault: false,
    },
  });

  // Reset form when app changes
  useEffect(() => {
    if (app) {
      form.reset({
        name: app.name,
        description: app.description,
        appUrl: app.appUrl,
        devUrl: app.devUrl,
        isDefault: app.isDefault,
      });
    }
  }, [app, form]);

  const onSubmit = async (data: EditAppFormData) => {
    if (!app) return;

    setIsPending(true);
    try {
      // Use collection's update method for optimistic update
      adminAppsCollection.update(app.id, (draft) => {
        draft.name = data.name;
        draft.description = data.description;
        draft.appUrl = data.appUrl;
        draft.devUrl = data.devUrl ?? null;
        draft.isDefault = data.isDefault ?? false;
        draft.updatedAt = new Date();
      });
      handleClose();
    } catch (err) {
      form.setError("root", {
        message: err instanceof Error ? err.message : "Failed to update app",
      });
    } finally {
      setIsPending(false);
    }
  };

  const handleClose = () => {
    form.reset();
    onClose();
  };

  const {
    register,
    watch,
    setValue,
    formState: { errors },
  } = form;

  const devUrl = watch("devUrl");

  const handleDevModeToggle = (enabled: boolean) => {
    setValue("devUrl", enabled ? DEFAULT_DEV_URL : null);
  };

  if (!open || !app) return null;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Edit App"
      description={`Editing ${app.appId}`}
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={handleClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="edit-app-form"
            className="btn btn-primary"
            disabled={isPending}
          >
            {isPending ? "Saving..." : "Save Changes"}
          </button>
        </>
      }
    >
      <form
        id="edit-app-form"
        onSubmit={form.handleSubmit(onSubmit)}
        className="space-y-4 mt-4"
      >
        <FormField
          label="App Name"
          placeholder="My App"
          registration={register("name")}
          error={errors.name}
        />
        <FormField
          label="Description"
          placeholder="Describe what your app does..."
          type="textarea"
          registration={register("description")}
          error={errors.description}
        />
        <FormField
          label="App URL"
          placeholder="https://my-app.[yoursubdomain].workers.dev"
          registration={register("appUrl")}
          error={errors.appUrl}
        />
        <DevModeFormSection
          devUrl={devUrl}
          onToggle={handleDevModeToggle}
          registration={register("devUrl")}
          error={errors.devUrl}
        />

        <div className="divider"></div>

        <div className="form-control">
          <label className="label cursor-pointer justify-start gap-3">
            <input
              type="checkbox"
              className="checkbox checkbox-primary"
              {...register("isDefault")}
            />
            <div>
              <span className="label-text font-medium">
                Auto-grant to new users
              </span>
              <p className="text-xs text-base-content/60">
                New users will automatically have access to this app
              </p>
            </div>
          </label>
        </div>

        {errors.root && (
          <div className="text-error text-sm">{errors.root.message}</div>
        )}
      </form>
    </Modal>
  );
}
