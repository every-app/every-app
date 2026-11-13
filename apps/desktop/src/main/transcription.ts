// The person's own transcription server (Settings → Transcription): what a recording and the
// Test button hand the helper. The address and model are settings; the optional API key is in
// the encrypted store with the sign-in. No Electron import (tested).

import type { Settings } from "@shared/ipc";
import { parseTranscriptionBaseUrl, type TranscriptionServerParams, type TranscriptionTestResult } from "@shared/transcriptionServer";
import type { HelperSupervisor } from "./helper/supervisor";

export const NO_ADDRESS = "Add your transcription server's address in Settings → Transcription.";
export const NO_MODEL = "Add your transcription server's model name in Settings → Transcription.";

/** What to send the helper for the server in `settings`. Throws, in words for a person, when
 * the address or model is missing or unusable. */
export function transcriptionServerParams(settings: Settings, apiKey: string | undefined): TranscriptionServerParams {
  const baseUrl = parseTranscriptionBaseUrl(settings.transcriptionBaseUrl);
  if (!baseUrl) throw new Error(NO_ADDRESS);
  const model = settings.transcriptionModel.trim();
  if (!model) throw new Error(NO_MODEL);
  return apiKey ? { baseUrl, model, apiKey } : { baseUrl, model };
}

/**
 * For a recording: undefined when the person hasn't turned their own server on (Scribe's
 * transcription is used). When it's on, the server's params, or an error: a recording never
 * falls back to OpenAI because the setting is incomplete.
 */
export function recordingTranscription(settings: Settings, apiKey: string | undefined): TranscriptionServerParams | undefined {
  if (!settings.ownTranscription) return undefined;
  try {
    return transcriptionServerParams(settings, apiKey);
  } catch (error) {
    throw new Error(`Your own transcription server is on, but isn't set up. ${(error as Error).message}`);
  }
}

/** Settings → Transcription → Test: whatever is saved, on or off. */
export function testTranscriptionServer(
  helper: Pick<HelperSupervisor, "request">,
  settings: Settings,
  apiKey: string | undefined,
): Promise<TranscriptionTestResult> {
  return helper.request("transcribe.test", transcriptionServerParams(settings, apiKey));
}
