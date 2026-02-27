import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/docs/quickstart")({
  beforeLoad: () => {
    throw redirect({
      to: "/docs/$",
      params: {
        _splat: "getting-started/quickstart",
      },
      statusCode: 301,
    });
  },
});
