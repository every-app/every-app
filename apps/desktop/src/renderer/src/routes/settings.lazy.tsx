import { createLazyRoute } from "@tanstack/react-router";
import { SettingsPage } from "../pages/Settings";

export const settingsRoute = createLazyRoute("/settings")({ component: SettingsPage });
