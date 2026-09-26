import { DeepgramEngine } from "./offscreen/deepgram-engine";
import type { CaptionEngine, Emit } from "./offscreen/engine";
import { LocalEngine } from "./offscreen/local-engine";
import { NemotronEngine } from "./offscreen/nemotron-engine";
import {
	type BackgroundMessage,
	CAPTION_PORT,
	type ClientMessage,
	type ServerMessage,
} from "./shared/messages";

/** Frees the model's GPU memory once no tab has used captions for a while. */
const IDLE_CLOSE_MS = 5 * 60 * 1000;

let activePorts = 0;
let idleTimer: number | undefined;

function decodePcm(base64: string): Int16Array<ArrayBuffer> {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new Int16Array(bytes.buffer);
}

chrome.runtime.onConnect.addListener((port) => {
	if (port.name !== CAPTION_PORT) return;
	activePorts++;
	clearTimeout(idleTimer);

	let engine: CaptionEngine | null = null;
	let disconnected = false;
	const emit: Emit = (message: ServerMessage) => {
		if (!disconnected) port.postMessage(message);
	};

	port.onMessage.addListener((message: ClientMessage) => {
		if (message.type === "audio") {
			engine?.push(decodePcm(message.pcm));
			return;
		}
		engine?.stop();
		if (message.config.engine === "deepgram") {
			engine = new DeepgramEngine(message.config, emit);
		} else if (
			message.config.model === "nemotron" ||
			message.config.model === "nemotron-multilingual"
		) {
			engine = new NemotronEngine(
				message.config.model,
				message.config.language,
				emit,
			);
		} else {
			engine = new LocalEngine(message.config.model, emit);
		}
	});

	port.onDisconnect.addListener(() => {
		disconnected = true;
		engine?.stop();
		activePorts--;
		if (activePorts > 0) return;
		idleTimer = window.setTimeout(() => {
			const message: BackgroundMessage = { type: "offscreen-idle" };
			void chrome.runtime.sendMessage(message);
		}, IDLE_CLOSE_MS);
	});
});
