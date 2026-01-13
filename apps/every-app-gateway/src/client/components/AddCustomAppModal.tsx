import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { userAppsCollection } from "@/client/tanstack-db";
import { useSession } from "@/client/hooks/useSession";
import { Modal } from "./Modal";
import { FormField } from "./FormField";
import { DevModeFormSection } from "./DevModeFormSection";
import {
  createUserAppSchema,
  DEFAULT_DEV_URL,
  type CreateUserAppFormData,
} from "@/schemas/user-app";

interface AddCustomAppModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddCustomAppModal({
  open,
  onOpenChange,
}: AddCustomAppModalProps) {
  const { data: session } = useSession();

  const form = useForm<CreateUserAppFormData>({
    resolver: zodResolver(createUserAppSchema),
    defaultValues: {
      appId: "",
      name: "",
      description: "",
      appUrl: "",
      devUrl: null,
    },
  });

  const onSubmit = (data: CreateUserAppFormData) => {
    if (!session?.user?.id) return;

    // Pre-generate ID before insert for optimistic update
    const id = crypto.randomUUID();
    const now = new Date();

    // Use collection.insert() for optimistic updates
    // The collection's onInsert handler will call the server
    userAppsCollection.insert({
      id,
      userId: session.user.id,
      appId: data.appId,
      name: data.name,
      description: data.description,
      appUrl: data.appUrl,
      devUrl: data.devUrl ?? null,
      createdAt: now,
      updatedAt: now,
    });

    onOpenChange(false);
    form.reset();
  };

  const handleClose = () => {
    onOpenChange(false);
    form.reset();
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
      // Replace "every-app-gateway" with the appId in the current URL
      // e.g., https://every-app-gateway.user.workers.dev -> https://my-app.user.workers.dev
      const suggestedUrl = window.location.origin.replace(
        "every-app-gateway",
        appId,
      );
      setValue("appUrl", suggestedUrl, { shouldDirty: true });
    }
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Add App"
      description="Create an entry for your application"
      actions={
        <>
          <button
            type="button"
            className="btn btn-outline"
            onClick={handleClose}
          >
            Cancel
          </button>
          <button type="submit" form="add-app-form" className="btn btn-primary">
            Add
          </button>
        </>
      }
    >
      <form id="add-app-form" onSubmit={form.handleSubmit(onSubmit)}>
        <FormField
          label="App ID"
          placeholder="my-custom-app"
          registration={register("appId")}
          error={errors.appId}
          onBlur={handleAppIdBlur}
        />
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
          placeholder="https://my-custom-app.[yoursubdomain].workers.dev"
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
