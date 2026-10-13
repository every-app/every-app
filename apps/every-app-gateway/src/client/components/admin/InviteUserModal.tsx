import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { inviteMember } from "@/serverFunctions/admin";
import { getServerErrorMessage } from "@/client/errors";
import { CodeBlock } from "@/client/components/CodeBlock";
import { Modal } from "../Modal";

type Role = "member" | "admin";
type InviteResult = Awaited<ReturnType<typeof inviteMember>>;

interface InviteUserModalProps {
  open: boolean;
  onClose: () => void;
  /** Called after an invitation is created and emailed. */
  onSuccess: () => void;
  /** Called after an invitation is created, emailed or not. */
  onInvited: () => void;
}

export function InviteUserModal({
  open,
  onClose,
  onSuccess,
  onInvited,
}: InviteUserModalProps) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [error, setError] = useState("");
  // Set when the invitation was created but not emailed: show its link.
  const [unsent, setUnsent] = useState<InviteResult | null>(null);

  const reset = () => {
    setEmail("");
    setRole("member");
    setError("");
    setUnsent(null);
  };

  const inviteMutation = useMutation({
    mutationFn: (data: { email: string; role: Role }) => inviteMember({ data }),
    onSuccess: (result) => {
      onInvited();
      if (result.emailSent) {
        reset();
        onSuccess();
      } else {
        setUnsent(result);
      }
    },
    onError: (err) => {
      setError(getServerErrorMessage(err, "Failed to create invite"));
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    inviteMutation.mutate({ email, role });
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  if (!open) return null;

  if (unsent) {
    return (
      <Modal
        open={open}
        onClose={handleClose}
        title="Copy invite link"
        description={`The invitation for ${unsent.email} was created but not emailed.`}
        actions={
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleClose}
          >
            Done
          </button>
        }
      >
        <div className="mt-4 space-y-3">
          <div className="alert alert-warning text-sm">
            {unsent.emailConfigured
              ? "Sending the invitation email failed."
              : "Email is not configured on this gateway."}{" "}
            Send this link to {unsent.email} yourself.
          </div>
          <CodeBlock code={unsent.inviteUrl} />
          <p className="text-sm text-base-content/60">
            Works once, until {new Date(unsent.expiresAt).toLocaleString()}, and
            only for an account with this email address.
          </p>
        </div>
      </Modal>
    );
  }

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
        <div className="form-control mt-3">
          <label className="label">
            <span className="label-text">Role</span>
          </label>
          <select
            className="select select-bordered w-full"
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
          >
            <option value="member">
              Member: opens the apps they are given
            </option>
            <option value="admin">Admin: also manages users and apps</option>
          </select>
        </div>
        {error && <div className="text-error text-sm mt-2">{error}</div>}
      </form>
    </Modal>
  );
}
