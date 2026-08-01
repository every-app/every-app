import tanstackEntry from "@tanstack/react-start/server-entry";
import { everyApp } from "@every-app/sdk/server";
import manifest from "../everyapp.config";

export default everyApp(async (request) => {
  return tanstackEntry.fetch(request);
}, manifest);
