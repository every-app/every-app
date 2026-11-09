import { createLazyRoute, getRouteApi } from "@tanstack/react-router";
import { FolderPage, SharedPage } from "../pages/Folders";

const folderApi = getRouteApi("/folders/$id");

export const folderRoute = createLazyRoute("/folders/$id")({
  component: function Folder() {
    return <FolderPage id={folderApi.useParams().id} />;
  },
});

export const sharedRoute = createLazyRoute("/shared")({ component: SharedPage });
