import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { userAppsCollection } from "@/client/tanstack-db";
import type { UserApp } from "@/types/user-app";
import { useEffect } from "react";
import { Modal } from "./Modal";
import { FormField, DisabledField } from "./FormField";
import { DevModeFormSection } from "./DevModeFormSection";
import {
  editUserAppSchema,
  DEFAULT_DEV_URL,
  type EditUserAppFormData,
} from "@/schemas/user-app";

interface EditAppModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  app: UserApp | null;
}

export function EditAppModal({ open, onOpenChange, app }: EditAppModalProps) {
  const form = useForm<EditUserAppFormData>({
    resolver: zodResolver(editUserAppSchema),
    defaultValues: {
      name: "",
      description: "",
      appUrl: "",
      devUrl: null,
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
        devUrl: app.devUrl ?? null,
      });
    }
  }, [app, form]);

  const onSubmit = async (data: EditUserAppFormData) => {
    if (!app) return;

    userAppsCollection.update(app.id, (draft) => {
      draft.name = data.name;
      draft.description = data.description;
      draft.appUrl = data.appUrl;
      draft.devUrl = data.devUrl ?? null;
      draft.updatedAt = new Date();
    });
    onOpenChange(false);
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
        <DisabledField label="App ID" value={app?.appId || ""} />
        <FormField
          label="App Name"
          placeholder="My Custom App"
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
          placeholder="https://your-app.example.com"
          registration={register("appUrl")}
          error={errors.appUrl}
        />
        <DevModeFormSection
          devUrl={devUrl}
          onToggle={handleDevModeToggle}
          registration={register("devUrl")}
          error={errors.devUrl}
        />
      </form>
    </Modal>
  );
}
