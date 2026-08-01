import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Modal } from "../Modal";
import { FormField } from "../FormField";
import { adminAppsCollection } from "@/client/tanstack-db";
import { getServerErrorMessage } from "@/client/errors";
import { editAppSchema, type EditAppFormData } from "@/schemas/app";
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
      isDefault: false,
    },
  });

  // Reset form when app changes
  useEffect(() => {
    if (app) {
      form.reset({
        name: app.name,
        description: app.description,
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
        draft.isDefault = data.isDefault ?? false;
        draft.updatedAt = new Date();
      });
      handleClose();
    } catch (err) {
      form.setError("root", {
        message: getServerErrorMessage(err, "Failed to update app"),
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
    formState: { errors },
  } = form;

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
        {app.hostname && (
          <div className="text-sm text-base-content/60">
            Served at <span className="font-mono">{app.hostname}</span> — set by{" "}
            <span className="font-mono">everyapp deploy</span>
          </div>
        )}

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
