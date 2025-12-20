import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { userAppsCollection } from "@/client/tanstack-db";
import { useSession } from "@/client/hooks/useSession";
import { Modal } from "./Modal";

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

  const form = useForm<AddCustomAppFormData>({
    resolver: zodResolver(addCustomAppSchema),
    defaultValues: {
      appId: "",
      name: "",
      description: "",
      appUrl: "",
    },
  });

  const onSubmit = (data: AddCustomAppFormData) => {
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
    formState: { errors },
  } = form;

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
      </form>
    </Modal>
  );
}
