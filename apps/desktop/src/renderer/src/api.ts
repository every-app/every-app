// /api/v1, typed with the contract, over the one allowlisted bridge call ("api:call"). Main adds
// the bearer and refreshes it; this file only shapes requests and names the query keys.

import type { ApiCallOptions, ApiMethod } from "@shared/ipc";
import type {
  CreateFolderInput,
  EditNotesResponse,
  FileMeetingResponse,
  FinishMeetingResponse,
  FolderResponse,
  GetMeetingResponse,
  ListFoldersResponse,
  ListMeetingsQuery,
  ListMeetingsResponse,
  ListTemplatesResponse,
  MeResponse,
  OkResponse,
  PatchMeetingInput,
  PatchMeetingResponse,
  SaveJottingsResponse,
  SaveTemplateInput,
  SearchResponse,
  SettingsResponse,
  ShareLinkResponse,
  TemplateResponse,
  UpdateFolderInput,
  UpdateSettingsInput,
  UpdateTemplateInput,
} from "@shared/contract";
import { cleanError } from "./errors";
import { bridge } from "./bridge";

const enc = encodeURIComponent;

async function call<T>(method: ApiMethod, path: string, opts?: ApiCallOptions): Promise<T> {
  try {
    return (await bridge["api:call"](method, `api/v1/${path}`, opts)) as T;
  } catch (error) {
    throw new Error(cleanError(error));
  }
}

export { cleanError } from "./errors";

function listQuery(query: ListMeetingsQuery): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) if (v !== undefined) out[k] = String(v);
  return out;
}

export const api = {
  me: () => call<MeResponse>("GET", "me"),
  settings: () => call<SettingsResponse>("GET", "settings"),
  updateSettings: (body: UpdateSettingsInput) => call<SettingsResponse>("PATCH", "settings", { body }),

  search: (q: string, cursor?: string, limit = 20) =>
    call<SearchResponse>("GET", "search", { query: { q, limit: String(limit), ...(cursor ? { cursor } : {}) } }),
  meetings: (query: ListMeetingsQuery = {}) => call<ListMeetingsResponse>("GET", "meetings", { query: listQuery(query) }),
  meeting: (id: string) => call<GetMeetingResponse>("GET", `meetings/${enc(id)}`),
  patchMeeting: (id: string, body: PatchMeetingInput) => call<PatchMeetingResponse>("PATCH", `meetings/${enc(id)}`, { body }),
  deleteMeeting: (id: string) => call<OkResponse>("DELETE", `meetings/${enc(id)}`),
  saveJottings: (id: string, markdown: string, updatedAt: string) =>
    call<SaveJottingsResponse>("PUT", `meetings/${enc(id)}/jottings`, { body: { markdown, updatedAt } }),
  finishMeeting: (id: string) => call<FinishMeetingResponse>("POST", `meetings/${enc(id)}/finish`),
  editNotes: (id: string, markdown: string) => call<EditNotesResponse>("PUT", `meetings/${enc(id)}/notes`, { body: { markdown } }),
  createShareLink: (id: string) => call<ShareLinkResponse>("POST", `meetings/${enc(id)}/share`),
  revokeShareLink: (id: string, linkId: string) => call<OkResponse>("DELETE", `meetings/${enc(id)}/share/${enc(linkId)}`),

  folders: () => call<ListFoldersResponse>("GET", "folders"),
  createFolder: (body: CreateFolderInput) => call<FolderResponse>("POST", "folders", { body }),
  updateFolder: (id: string, body: UpdateFolderInput) => call<FolderResponse>("PATCH", `folders/${enc(id)}`, { body }),
  deleteFolder: (id: string) => call<OkResponse>("DELETE", `folders/${enc(id)}`),
  fileMeeting: (folderId: string, meetingId: string) =>
    call<FileMeetingResponse>("PUT", `folders/${enc(folderId)}/meetings/${enc(meetingId)}`),
  unfileMeeting: (folderId: string, meetingId: string) =>
    call<OkResponse>("DELETE", `folders/${enc(folderId)}/meetings/${enc(meetingId)}`),

  templates: () => call<ListTemplatesResponse>("GET", "templates"),
  createTemplate: (body: SaveTemplateInput) => call<TemplateResponse>("POST", "templates", { body }),
  updateTemplate: (id: string, body: UpdateTemplateInput) => call<TemplateResponse>("PATCH", `templates/${enc(id)}`, { body }),
  deleteTemplate: (id: string) => call<OkResponse>("DELETE", `templates/${enc(id)}`),
  duplicateTemplate: (id: string) => call<TemplateResponse>("POST", `templates/${enc(id)}/duplicate`),
};

/** Query keys, so mutations invalidate the right lists. */
export const keys = {
  me: ["me"] as const,
  settings: ["settings"] as const,
  meetings: (query: ListMeetingsQuery = {}) => ["meetings", query] as const,
  allMeetings: ["meetings"] as const,
  meeting: (id: string) => ["meeting", id] as const,
  folders: ["folders"] as const,
  templates: ["templates"] as const,
  search: (q: string) => ["search", q] as const,
};
