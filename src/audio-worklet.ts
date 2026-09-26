// Runs in the AudioWorkletGlobalScope; these globals are not part of the DOM lib.
declare const sampleRate: number;
declare function registerProcessor(
	name: string,
	processor: new () => AudioWorkletProcessorBase,
): void;
declare class AudioWorkletProcessorBase {
	readonly port: MessagePort;
}
declare const AudioWorkletProcessor: typeof AudioWorkletProcessorBase;

const TARGET_RATE = 16000;
/** 100 ms per message keeps port traffic low while staying well under Deepgram's recommended chunk size. */
const CHUNK_SAMPLES = 1600;

/**
 * Downmixes to mono and decimates to 16 kHz with a box filter, emitting Int16 PCM chunks.
 * Browsers ignore AudioContext sampleRate hints in some configurations, so resampling happens here.
 */
class CaptureProcessor extends AudioWorkletProcessor {
	private readonly ratio = sampleRate / TARGET_RATE;
	private sum = 0;
	private count = 0;
	private position = 0;
	private chunk = new Int16Array(CHUNK_SAMPLES);
	private filled = 0;

	process(inputs: Float32Array[][]): boolean {
		const channels = inputs[0];
		const left = channels?.[0];
		if (!channels || !left) return true;
		const right = channels[1];

		for (let i = 0; i < left.length; i++) {
			this.sum += right
				? ((left[i] ?? 0) + (right[i] ?? 0)) * 0.5
				: (left[i] ?? 0);
			this.count++;
			this.position++;
			if (this.position < this.ratio) continue;

			const sample = Math.max(-1, Math.min(1, this.sum / this.count));
			this.chunk[this.filled++] =
				sample < 0 ? sample * 0x8000 : sample * 0x7fff;
			this.sum = 0;
			this.count = 0;
			this.position -= this.ratio;

			if (this.filled === CHUNK_SAMPLES) {
				this.port.postMessage(this.chunk, [this.chunk.buffer]);
				this.chunk = new Int16Array(CHUNK_SAMPLES);
				this.filled = 0;
			}
		}
		return true;
	}
}

registerProcessor("tcc-capture", CaptureProcessor);
