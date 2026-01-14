import { createFileRoute, Link } from "@tanstack/react-router";
import { GameSnake } from "@/components/GameSnake";

export const Route = createFileRoute("/snake")({
  component: SnakePage,
});

function SnakePage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-base-100 py-8">
      <div className="w-full max-w-md px-4 flex flex-col items-center gap-6">
        <img src="/transparent-logo.png" alt="Logo" className="h-12 w-auto" />
        <GameSnake />
        <Link to="/" className="btn btn-ghost btn-sm">
          Back to Gateway
        </Link>
      </div>
    </div>
  );
}
