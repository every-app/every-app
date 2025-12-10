import { auth } from "@/auth";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const response = await auth.handler(request);

        return response;
      },
      POST: async ({ request }: { request: Request }) => {
        // Log the body if it's JSON - but don't consume the original request
        let requestToPass = request;
        try {
          if (
            request.headers.get("content-type")?.includes("application/json")
          ) {
            const body = await request.text();
            // Create a new request with the same body since we consumed it
            requestToPass = new Request(request.url, {
              method: request.method,
              headers: request.headers,
              body: body,
            });
          }
        } catch (e) {
          console.log("Could not read request body");
        }

        const response = await auth.handler(requestToPass);

        return response;
      },
    },
  },
});
