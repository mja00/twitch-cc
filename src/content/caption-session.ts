import {
	type BackgroundMessage,
	CAPTION_PORT,
	type ClientMessage,
	type EngineConfig,
	type EngineStatus,
	type ServerMessage,
} from "../shared/messages";
import { AudioCapture } from "./audio-capture";

const RECONNECT_DELAY_MS = 1500;

export interface SessionHandlers {
	onCaption(text: string, final: boolean): void;
	onStatus(status: EngineStatus): void;
	/** Called when the AudioContext needs a user gesture before audio can flow. */
	onSuspended(suspended: boolean): void;
}

/** Streams one video's audio to the offscreen transcription engine and relays captions back. */
export class CaptionSession {
	private readonly capture: AudioCapture;
	private port: chrome.runtime.Port | null = null;
	private closed = false;
	private reconnectTimer: number | undefined;
	private readonly resumeOnGesture = () => void this.resume();

	constructor(
		video: HTMLVideoElement,
		private readonly config: EngineConfig,
		private readonly handlers: SessionHandlers,
	) {
		this.capture = new AudioCapture(video, (pcm) => this.sendAudio(pcm));
	}

	async open() {
		this.handlers.onStatus({ state: "loading", detail: "Starting captions…" });
		try {
			const running = await this.capture.start();
			if (!running && !this.closed) {
				this.handlers.onSuspended(true);
				document.addEventListener("pointerdown", this.resumeOnGesture, true);
				document.addEventListener("keydown", this.resumeOnGesture, true);
			}
		} catch (error) {
			this.handlers.onStatus({
				state: "error",
				detail: `Could not capture stream audio: ${String(error)}`,
			});
			return;
		}
		await this.connect();
	}

	close() {
		this.closed = true;
		clearTimeout(this.reconnectTimer);
		this.removeGestureListeners();
		this.port?.disconnect();
		this.port = null;
		this.capture.stop();
	}

	private async connect() {
		if (this.closed) return;
		try {
			const message: BackgroundMessage = { type: "ensure-offscreen" };
			const response: { ok: boolean; error?: string } | undefined =
				await chrome.runtime.sendMessage(message);
			if (!response?.ok) throw new Error(response?.error ?? "no response");
			if (this.closed) return;
			const port = chrome.runtime.connect({ name: CAPTION_PORT });
			port.onMessage.addListener((message: ServerMessage) => {
				if (message.type === "caption") {
					this.handlers.onCaption(message.text, message.final);
				} else {
					this.handlers.onStatus(message);
				}
			});
			port.onDisconnect.addListener(() => {
				this.port = null;
				this.scheduleReconnect();
			});
			const start: ClientMessage = { type: "start", config: this.config };
			port.postMessage(start);
			this.port = port;
		} catch (error) {
			// The extension was reloaded or updated; this content script can no longer reach it.
			if (!chrome.runtime?.id) {
				this.handlers.onStatus({
					state: "error",
					detail: "Captions extension was updated. Reload the page.",
				});
				this.close();
				return;
			}
			console.warn("[twitch-cc] connect failed", error);
			this.scheduleReconnect();
		}
	}

	private scheduleReconnect() {
		if (this.closed) return;
		clearTimeout(this.reconnectTimer);
		this.handlers.onStatus({ state: "loading", detail: "Reconnecting…" });
		this.reconnectTimer = window.setTimeout(
			() => void this.connect(),
			RECONNECT_DELAY_MS,
		);
	}

	private sendAudio(pcm: Int16Array) {
		if (!this.port) return;
		const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
		const message: ClientMessage = {
			type: "audio",
			pcm: btoa(String.fromCharCode(...bytes)),
		};
		this.port.postMessage(message);
	}

	private async resume() {
		if (await this.capture.resume()) {
			this.removeGestureListeners();
			this.handlers.onSuspended(false);
		}
	}

	private removeGestureListeners() {
		document.removeEventListener("pointerdown", this.resumeOnGesture, true);
		document.removeEventListener("keydown", this.resumeOnGesture, true);
	}
}
