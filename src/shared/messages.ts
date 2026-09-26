import type { DeepgramModel, LocalModel } from "./settings";

export const CAPTION_PORT = "captions";
/** Audio sent to the transcription engines is 16 kHz mono signed 16-bit PCM. */
export const SAMPLE_RATE = 16000;

export type EngineConfig =
	| { engine: "local"; model: LocalModel }
	| { engine: "deepgram"; apiKey: string; model: DeepgramModel };

/** Content script -> offscreen document, over the `captions` port. */
export type ClientMessage =
	| { type: "start"; config: EngineConfig }
	/** Base64 encoded little-endian Int16 PCM, because extension ports JSON-serialize messages. */
	| { type: "audio"; pcm: string };

export type EngineStatus =
	| { state: "loading"; detail: string; progress?: number }
	| { state: "ready" }
	| { state: "error"; detail: string };

/** Offscreen document -> content script, over the `captions` port. */
export type ServerMessage =
	| ({ type: "status" } & EngineStatus)
	| { type: "caption"; text: string; final: boolean };

/** One-off runtime messages handled by the service worker. */
export type BackgroundMessage =
	| { type: "ensure-offscreen" }
	| { type: "offscreen-idle" };

/** Popup -> content script (top frame) messages. */
export type TabMessage =
	| { type: "get-state" }
	| { type: "set-enabled"; enabled: boolean };

export interface TabState {
	enabled: boolean;
	hasPlayer: boolean;
	status: string;
}
