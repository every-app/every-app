import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authClient } from "@/client/auth-client";
import { CpuTimeoutWarning } from "@/client/components/CpuTimeoutWarning";
import { useCpuTimeoutRetry } from "@/client/hooks/useCpuTimeoutRetry";
import { claimGateway, readSetupToken } from "@/client/setup-link";
import { refetchCollectionsAfterAuth } from "@/client/tanstack-db";
import { hasOwner } from "@/serverFunctions/admin";

export const Route = createFileRoute("/setup")({
  component: Setup,
});

function AuthCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen items-center justify-center overflow-hidden">
      <div className="relative w-full max-w-md">
        <img
          src="/transparent-logo.png"
          alt="Logo"
          className="h-12 w-auto absolute left-1/2 -translate-x-1/2 -top-12"
        />
        <div className="card auth-card">
          <div className="card-body">{children}</div>
        </div>
      </div>
    </div>
  );
}

/**
 * Claim a freshly deployed gateway with the one-time link the CLI printed
 * (`/setup#token=est_…`). The token is read from the fragment once, kept only
 * in memory, and the address bar is reset to `/setup` straight away.
 */
function Setup() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const { data: ownerData, isLoading } = useQuery({
    queryKey: ["hasOwner"],
    queryFn: () => hasOwner(),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  useEffect(() => {
    // Keep a token already read: React's StrictMode runs this effect twice in
    // development, and by the second run the fragment is gone.
    const fromHash = readSetupToken(window.location.hash);
    setToken((current) => current ?? fromHash);
    if (window.location.hash) {
      window.history.replaceState(null, "", "/setup");
    }
  }, []);

  if (isLoading || token === undefined) return null;

  if (ownerData?.hasOwner) {
    return (
      <AuthCard>
        <h2 className="card-title">Gateway already set up</h2>
        <p className="text-base-content/70">
          This gateway already has an owner.
        </p>
        <Link to="/sign-in" className="btn btn-primary mt-4">
          Sign in
        </Link>
      </AuthCard>
    );
  }

  if (!token) {
    return (
      <AuthCard>
        <h2 className="card-title">Setup link required</h2>
        <p className="text-base-content/70">
          Open the setup link that was printed when this gateway was deployed,
          or create a new one on the machine that deployed it:
        </p>
        <code className="block mt-3 text-sm">
          npx everyapp gateway claim-link
        </code>
      </AuthCard>
    );
  }

  return <ClaimForm token={token} />;
}

function ClaimForm({ token }: { token: string }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const finish = async () => {
    await queryClient.invalidateQueries({ queryKey: ["hasOwner"] });
    navigate({ to: "/" });
  };

  const {
    isRunning,
    attemptCount,
    maxRetries,
    hasExhaustedRetries,
    secondsUntilRetry,
    isRetrySuccess,
    showWarning,
    hadRetries,
    setRetrySuccess,
    executeWithRetry,
  } = useCpuTimeoutRetry(async () => {
    const result = await claimGateway({ token, name, email, password });
    if (!result.ok) {
      if (result.retry) return false;
      setError(result.message);
      return true;
    }

    const { error: signInError } = await authClient.signIn.email({
      email,
      password,
    });
    if (signInError) {
      navigate({ to: "/sign-in" });
      return true;
    }
    await queryClient.refetchQueries({ queryKey: ["auth", "session"] });
    refetchCollectionsAfterAuth();
    if (hadRetries) {
      setRetrySuccess();
    } else {
      await finish();
    }
    return true;
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    executeWithRetry();
  };

  if (showWarning || isRetrySuccess) {
    return (
      <CpuTimeoutWarning
        attemptCount={attemptCount}
        maxRetries={maxRetries}
        hasExhaustedRetries={hasExhaustedRetries}
        secondsUntilRetry={secondsUntilRetry}
        isSuccess={isRetrySuccess}
        onContinue={() => void finish()}
      />
    );
  }

  return (
    <AuthCard>
      <h2 className="card-title">Set up your gateway</h2>
      <p>Create the owner account for this gateway.</p>

      <form onSubmit={handleSubmit}>
        <div className="form-control">
          <label className="label">
            <span className="label-text">Name</span>
          </label>
          <input
            id="name"
            type="text"
            placeholder="Your name"
            className="input input-bordered w-full"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
            disabled={isRunning}
          />
        </div>
        <div className="form-control">
          <label className="label">
            <span className="label-text">Email</span>
          </label>
          <input
            id="email"
            type="email"
            placeholder="you@example.com"
            className="input input-bordered w-full"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={isRunning}
          />
        </div>
        <div className="form-control">
          <label className="label">
            <span className="label-text">Password</span>
          </label>
          <input
            id="password"
            type="password"
            placeholder="Create a password"
            className="input input-bordered w-full"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            maxLength={128}
            disabled={isRunning}
          />
          <label className="label">
            <span className="label-text-alt text-base-content/60">
              Password must be at least 8 characters
            </span>
          </label>
        </div>
        <div className="form-control">
          <label className="label">
            <span className="label-text">Confirm Password</span>
          </label>
          <input
            id="confirmPassword"
            type="password"
            placeholder="Confirm your password"
            className="input input-bordered w-full"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            minLength={8}
            maxLength={128}
            disabled={isRunning}
          />
        </div>
        {error && <div className="text-sm text-error">{error}</div>}
        <button
          type="submit"
          className="btn btn-primary w-full"
          disabled={isRunning}
        >
          {isRunning ? "Setting up..." : "Create Owner Account"}
        </button>
      </form>
    </AuthCard>
  );
}
