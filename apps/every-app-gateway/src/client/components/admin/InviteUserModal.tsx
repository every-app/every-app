import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { createInviteLink } from "@/serverFunctions/admin";
import { Modal } from "../Modal";

interface InviteUserModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (inviteUrl: string) => void;
}

export function InviteUserModal({
  open,
  onClose,
  onSuccess,
}: InviteUserModalProps) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");

  const inviteMutation = useMutation({
    mutationFn: (data: { email: string }) => createInviteLink({ data }),
    onSuccess: (data) => {
      setEmail("");
      setError("");
      onSuccess(data.inviteUrl);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to create invite");
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    inviteMutation.mutate({ email });
  };

  const handleClose = () => {
    setEmail("");
    setError("");
    onClose();
  };

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Invite User"
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={handleClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="invite-user-form"
            className="btn btn-primary"
            disabled={inviteMutation.isPending}
          >
            {inviteMutation.isPending ? "Inviting..." : "Invite"}
          </button>
        </>
      }
    >
      <form id="invite-user-form" onSubmit={handleSubmit} className="mt-4">
        <div className="form-control">
          <label className="label">
            <span className="label-text">Email</span>
          </label>
          <input
            type="email"
            placeholder="user@example.com"
            className="input input-bordered w-full"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        {error && <div className="text-error text-sm mt-2">{error}</div>}
      </form>
    </Modal>
  );
}
