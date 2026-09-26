declare global {
	interface HTMLMediaElement {
		captureStream(): MediaStream;
	}
}

/**
 * Taps a video element's audio without rerouting playback. `captureStream()` is unaffected by the
 * element's mute/volume, so captions keep working when the viewer mutes the stream.
 */
export class AudioCapture {
	private context: AudioContext | null = null;
	private stream: MediaStream | null = null;
	private source: MediaStreamAudioSourceNode | null = null;
	private node: AudioWorkletNode | null = null;
	private stopped = false;

	constructor(
		private readonly video: HTMLVideoElement,
		private readonly onChunk: (pcm: Int16Array) => void,
	) {}

	/** Resolves to `false` when the browser's autoplay policy is holding the AudioContext suspended. */
	async start(): Promise<boolean> {
		const context = new AudioContext();
		this.context = context;
		await context.audioWorklet.addModule(
			chrome.runtime.getURL("audio-worklet.js"),
		);
		if (this.stopped) return true;

		const node = new AudioWorkletNode(context, "tcc-capture");
		node.port.onmessage = (event: MessageEvent<Int16Array>) => {
			// Paused or buffering streams produce silence; skipping it saves inference and Deepgram minutes.
			if (this.video.paused || this.video.readyState < 3) return;
			this.onChunk(event.data);
		};
		// The processor writes no output, but Chrome only pulls nodes that reach the destination.
		node.connect(context.destination);
		this.node = node;

		const stream = this.video.captureStream();
		this.stream = stream;
		// Twitch swaps MediaSource buffers on quality changes and ads, which replaces the audio track.
		stream.addEventListener("addtrack", () => this.connectSource());
		stream.addEventListener("removetrack", () => this.connectSource());
		this.connectSource();

		return context.state === "running";
	}

	async resume(): Promise<boolean> {
		if (!this.context) return false;
		await this.context.resume();
		return this.context.state === "running";
	}

	stop() {
		this.stopped = true;
		if (this.node) this.node.port.onmessage = null;
		this.source?.disconnect();
		for (const track of this.stream?.getTracks() ?? []) track.stop();
		void this.context?.close();
		this.context = null;
	}

	private connectSource() {
		if (!this.context || !this.node || !this.stream) return;
		this.source?.disconnect();
		this.source = null;
		if (this.stream.getAudioTracks().length === 0) return;
		this.source = this.context.createMediaStreamSource(this.stream);
		this.source.connect(this.node);
	}
}
