import { createLazyRoute, getRouteApi } from "@tanstack/react-router";
import { TemplatesPage } from "../pages/Templates";

const templatesApi = getRouteApi("/templates");

export const templatesRoute = createLazyRoute("/templates")({
  component: function Templates() {
    return <TemplatesPage selected={templatesApi.useSearch().id} />;
  },
});
