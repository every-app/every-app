import { createLazyRoute, getRouteApi } from "@tanstack/react-router";
import { SearchPage } from "../pages/Search";

const searchApi = getRouteApi("/search");

export const searchRoute = createLazyRoute("/search")({
  component: function Search() {
    const { q } = searchApi.useSearch();
    return <SearchPage q={q ?? ""} />;
  },
});
