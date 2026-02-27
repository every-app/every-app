import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/docs/build-an-app")({
  beforeLoad: () => {
    throw redirect({
      to: "/docs/$",
      params: {
        _splat: "build-an-app/create-app",
      },
      statusCode: 301,
    });
  },
});
