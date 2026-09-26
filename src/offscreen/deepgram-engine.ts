import { type EngineConfig, SAMPLE_RATE } from "../shared/messages";
import type { CaptionEngine, Emit } from "./engine";

/** Deepgram closes idle sockets after ~10 s without audio (NET-0001). */
const KEEPALIVE_MS = 5000;
const MAX_FAILED_CONNECTS = 3;

interface DeepgramResult {
	type: string;
	is_final?: boolean;
	channel?: { alternatives?: { transcript?: string }[] };
}

export class DeepgramEngine implements CaptionEngine {
	private socket: WebSocket | null = null;
	private stopped = false;
	private failedConnects = 0;
	private lastSendAt = 0;
	private readonly keepAlive: number;
	private reconnectTimer: number | undefined;

	constructor(
		private readonly config: Extract<EngineConfig, { engine: "deepgram" }>,
		private readonly emit: Emit,
	) {
		this.keepAlive = window.setInterval(() => {
			if (
				this.socket?.readyState === WebSocket.OPEN &&
				Date.now() - this.lastSendAt > KEEPALIVE_MS
			) {
				this.socket.send(JSON.stringify({ type: "KeepAlive" }));
				this.lastSendAt = Date.now();
			}
		}, KEEPALIVE_MS);
		this.connect();
	}

	push(pcm: Int16Array<ArrayBuffer>) {
		if (this.socket?.readyState !== WebSocket.OPEN) return;
		this.socket.send(pcm);
		this.lastSendAt = Date.now();
	}

	stop() {
		this.stopped = true;
		clearInterval(this.keepAlive);
		clearTimeout(this.reconnectTimer);
		const socket = this.socket;
		this.socket = null;
		if (socket?.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ type: "CloseStream" }));
		}
		socket?.close();
	}

	private connect() {
		const url = new URL("wss://api.deepgram.com/v1/listen");
		url.search = new URLSearchParams({
			model: this.config.model,
			language: "en",
			encoding: "linear16",
			sample_rate: String(SAMPLE_RATE),
			channels: "1",
			interim_results: "true",
			smart_format: "true",
			punctuate: "true",
			endpointing: "300",
		}).toString();

		this.emit({
			type: "status",
			state: "loading",
			detail: "Connecting to Deepgram…",
		});
		// Browsers can't set an Authorization header on WebSockets; Deepgram accepts the key as a subprotocol.
		const socket = new WebSocket(url, ["token", this.config.apiKey]);
		socket.binaryType = "arraybuffer";
		let opened = false;

		socket.onopen = () => {
			opened = true;
			this.failedConnects = 0;
			this.emit({ type: "status", state: "ready" });
		};
		socket.onmessage = (event) => {
			if (typeof event.data !== "string") return;
			const result = JSON.parse(event.data) as DeepgramResult;
			if (result.type !== "Results") return;
			const text = result.channel?.alternatives?.[0]?.transcript ?? "";
			const final = result.is_final === true;
			if (!text && !final) return;
			this.emit({ type: "caption", text, final });
		};
		socket.onclose = () => {
			if (this.stopped || this.socket !== socket) return;
			this.socket = null;
			if (!opened) this.failedConnects++;
			if (this.failedConnects >= MAX_FAILED_CONNECTS) {
				this.emit({
					type: "status",
					state: "error",
					detail:
						"Could not connect to Deepgram. Check your API key in the Live Captions settings.",
				});
				return;
			}
			this.reconnectTimer = window.setTimeout(
				() => this.connect(),
				1000 * 2 ** this.failedConnects,
			);
		};
		this.socket = socket;
	}
}
