import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Modal } from "../Modal";
import { FormField } from "../FormField";
import { DevModeFormSection } from "../DevModeFormSection";
import { createAppAction } from "@/client/actions/createApp";
import { getServerErrorMessage } from "@/client/errors";
import { createAppSchema, type CreateAppFormData } from "@/schemas/app";
import { DEFAULT_DEV_URL } from "@/schemas/user-app";

interface AddAppModalProps {
  open: boolean;
  onClose: () => void;
}

export function AddAppModal({ open, onClose }: AddAppModalProps) {
  const [isPending, setIsPending] = useState(false);

  const form = useForm<CreateAppFormData>({
    resolver: zodResolver(createAppSchema),
    defaultValues: {
      appId: "",
      name: "",
      description: "",
      appUrl: "",
      devUrl: null,
      isDefault: true,
      grantToAllExisting: true,
    },
  });

  const onSubmit = async (data: CreateAppFormData) => {
    setIsPending(true);
    try {
      await createAppAction({
        id: crypto.randomUUID(),
        ...data,
      });
      handleClose();
    } catch (err) {
      form.setError("root", {
        message: getServerErrorMessage(err, "Failed to create app"),
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
  const appUrl = watch("appUrl");

  const handleDevModeToggle = (enabled: boolean) => {
    setValue("devUrl", enabled ? DEFAULT_DEV_URL : null);
  };

  const handleAppIdBlur = (
    e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    const appId = e.target.value;
    if (appId && !appUrl && window.location.hostname !== "localhost") {
      const urlAppId = appId.startsWith("every-") ? appId : `every-${appId}`;
      const suggestedUrl = window.location.origin.replace(
        "every-app-gateway",
        urlAppId,
      );
      setValue("appUrl", suggestedUrl, { shouldDirty: true });
    }
  };

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Add App"
      description="Add a new app to the catalog"
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={handleClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="add-app-form"
            className="btn btn-primary"
            disabled={isPending}
          >
            {isPending ? "Adding..." : "Add App"}
          </button>
        </>
      }
    >
      <form
        id="add-app-form"
        onSubmit={form.handleSubmit(onSubmit)}
        className="space-y-4 mt-4"
      >
        <FormField
          label="App ID"
          placeholder="my-app"
          registration={register("appId")}
          error={errors.appId}
          onBlur={handleAppIdBlur}
        />
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

        <div className="form-control">
          <label className="label cursor-pointer justify-start gap-3">
            <input
              type="checkbox"
              className="checkbox checkbox-primary"
              {...register("grantToAllExisting")}
            />
            <div>
              <span className="label-text font-medium">
                Grant to all existing users
              </span>
              <p className="text-xs text-base-content/60">
                All current users will immediately have access
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
