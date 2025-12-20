import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { userAppsCollection } from "@/client/tanstack-db";
import type { UserApp } from "@/types/user-app";
import { useEffect } from "react";
import { Modal } from "./Modal";

const editAppSchema = z.object({
  name: z.string().min(1, "App name is required").max(255, "App name too long"),
  description: z
    .string()
    .min(1, "Description is required")
    .max(1000, "Description too long"),
  appUrl: z.string().url("Please enter a valid URL"),
});

type EditAppFormData = z.infer<typeof editAppSchema>;

interface EditAppModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  app: UserApp | null;
}

export function EditAppModal({ open, onOpenChange, app }: EditAppModalProps) {
  const form = useForm<EditAppFormData>({
    resolver: zodResolver(editAppSchema),
    defaultValues: {
      name: "",
      description: "",
      appUrl: "",
    },
  });

  const handleClose = () => {
    onOpenChange(false);
    form.reset();
  };

  // Update form when app changes
  useEffect(() => {
    if (app) {
      form.reset({
        name: app.name,
        description: app.description,
        appUrl: app.appUrl,
      });
    }
  }, [app, form]);

  const onSubmit = async (data: EditAppFormData) => {
    if (!app) return;

    userAppsCollection.update(app.id, (draft) => {
      draft.name = data.name;
      draft.description = data.description;
      draft.appUrl = data.appUrl;
      draft.updatedAt = new Date();
    });
    onOpenChange(false);
  };

  const {
    register,
    formState: { errors },
  } = form;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Edit App"
      description="Update your application details"
      actions={
        <>
          <button
            type="button"
            className="btn btn-outline"
            onClick={handleClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="edit-app-form"
            className="btn btn-primary"
          >
            Save Changes
          </button>
        </>
      }
    >
      <form id="edit-app-form" onSubmit={form.handleSubmit(onSubmit)}>
        <div className="form-control">
          <label className="label">
            <span className="label-text">App ID</span>
          </label>
          <input
            type="text"
            className="input input-bordered w-full"
            value={app?.appId || ""}
            disabled
          />
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
      </form>
    </Modal>
  );
}
