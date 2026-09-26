import {
	AutoModel,
	type AutomaticSpeechRecognitionPipeline,
	env,
	type PreTrainedModel,
	pipeline,
	Tensor,
} from "@huggingface/transformers";
import { SAMPLE_RATE } from "../shared/messages";
import type { TransformersModel } from "../shared/settings";
import type { CaptionEngine, Emit } from "./engine";
import { cleanTranscript } from "./transcript-cleanup";

env.allowLocalModels = false;
// MV3 forbids remote code, so ONNX Runtime's wasm is bundled; the blob-URL wasm cache would also violate the CSP.
env.useWasmCache = false;
const onnxWasm = env.backends.onnx.wasm;
if (onnxWasm) {
	onnxWasm.wasmPaths = chrome.runtime.getURL("ort/");
	onnxWasm.numThreads = 1;
}

/** Silero VAD consumes fixed 32 ms frames at 16 kHz. */
const FRAME_SAMPLES = 512;
const SPEECH_THRESHOLD = 0.3;
/** Hysteresis: once speaking, stay in speech until probability drops below this. */
const EXIT_THRESHOLD = 0.1;
const PREROLL_FRAMES = 3;
const END_SILENCE_SAMPLES = 0.4 * SAMPLE_RATE;
/** Past this length a shorter pause is enough to close a segment, keeping re-transcription cheap. */
const SOFT_MAX_SAMPLES = 5 * SAMPLE_RATE;
const SOFT_SILENCE_SAMPLES = 0.16 * SAMPLE_RATE;
const HARD_MAX_SAMPLES = 8 * SAMPLE_RATE;
const INTERIM_STEP_SAMPLES = 0.35 * SAMPLE_RATE;
const MIN_SEGMENT_SAMPLES = 0.3 * SAMPLE_RATE;
/** If inference falls behind, drop old audio so captions stay live instead of lagging further. */
const MAX_BACKLOG_SAMPLES = 3 * SAMPLE_RATE;
const MIN_TRACKED_BYTES = 5 * 1024 * 1024;

type Device = "webgpu" | "wasm";
type Dtype = Record<string, string>;

interface ModelSpec {
	id: string;
	webgpu: Dtype;
	/** Null when the model is too heavy to run on the CPU fallback. */
	wasm: Dtype | null;
	/** q4f16 weights need the WebGPU `shader-f16` feature. */
	needsF16: boolean;
	/** Generous per-second token budget; the cap stops decoder loops on music and noise. */
	tokensPerSecond: number;
	generation: Record<string, unknown>;
}

const MODEL_SPECS: Record<TransformersModel, ModelSpec> = {
	cohere: {
		id: "onnx-community/cohere-transcribe-03-2026-ONNX",
		webgpu: { encoder_model: "q4f16", decoder_model_merged: "q4f16" },
		wasm: null,
		needsF16: true,
		tokensPerSecond: 8,
		generation: { language: "en" },
	},
	base: {
		id: "onnx-community/moonshine-base-ONNX",
		webgpu: { encoder_model: "fp32", decoder_model_merged: "q4" },
		wasm: { encoder_model: "fp32", decoder_model_merged: "q8" },
		needsF16: false,
		tokensPerSecond: 6.5,
		generation: {},
	},
	tiny: {
		id: "onnx-community/moonshine-tiny-ONNX",
		webgpu: { encoder_model: "fp32", decoder_model_merged: "q4" },
		wasm: { encoder_model: "fp32", decoder_model_merged: "q8" },
		needsF16: false,
		tokensPerSecond: 6.5,
		generation: {},
	},
};

function generationOptions(spec: ModelSpec, samples: number) {
	const seconds = samples / SAMPLE_RATE;
	return {
		...spec.generation,
		max_new_tokens: Math.ceil(seconds * spec.tokensPerSecond) + 4,
	};
}

interface Models {
	asr: AutomaticSpeechRecognitionPipeline;
	vad: PreTrainedModel;
}

type ProgressListener = (progress: number) => void;

let vadPromise: Promise<PreTrainedModel> | null = null;
/** Never disposed: releasing ONNX sessions while another model loads invalidated live sessions. Idle offscreen close frees them. */
const asrLoads = new Map<
	TransformersModel,
	Promise<AutomaticSpeechRecognitionPipeline>
>();
const progressListeners = new Set<ProgressListener>();
/** Transformers.js can't interleave two generate() calls safely, and FIFO order keeps captions in sequence. */
let asrQueue: Promise<unknown> = Promise.resolve();

async function pickDevice(needsF16: boolean): Promise<Device> {
	const gpu = (
		navigator as Navigator & {
			gpu?: {
				requestAdapter(): Promise<{ features: ReadonlySet<string> } | null>;
			};
		}
	).gpu;
	if (!gpu) return "wasm";
	try {
		const adapter = await gpu.requestAdapter();
		if (!adapter) return "wasm";
		if (needsF16 && !adapter.features.has("shader-f16")) return "wasm";
		return "webgpu";
	} catch {
		return "wasm";
	}
}

async function createAsr(
	spec: ModelSpec,
	device: Device,
	dtype: Dtype,
): Promise<AutomaticSpeechRecognitionPipeline> {
	// Transformers.js' progress_total also counts files it predicts but never fetches (Cohere's fp32 encoder), so it stalls at ~17%.
	const fetched = new Map<string, { loaded: number; total: number }>();
	const asr = await pipeline("automatic-speech-recognition", spec.id, {
		device,
		dtype: dtype as never,
		progress_callback: (info) => {
			// Only weights are big enough to matter; small graph/config files finish first and make the percentage jump.
			if (info.status !== "progress" || info.total < MIN_TRACKED_BYTES) return;
			fetched.set(info.file, { loaded: info.loaded, total: info.total });
			let loaded = 0;
			let total = 0;
			for (const file of fetched.values()) {
				loaded += file.loaded;
				total += file.total;
			}
			if (total === 0) return;
			for (const listener of progressListeners) {
				listener((loaded / total) * 100);
			}
		},
	});
	// Compiles WebGPU shaders up front so the first real caption isn't delayed.
	await asr(
		new Float32Array(SAMPLE_RATE),
		generationOptions(spec, SAMPLE_RATE) as never,
	);
	return asr;
}

function loadAsr(
	model: TransformersModel,
): Promise<AutomaticSpeechRecognitionPipeline> {
	const cached = asrLoads.get(model);
	if (cached) return cached;
	const spec = MODEL_SPECS[model];
	const promise = (async () => {
		const device = await pickDevice(spec.needsF16);
		if (device === "webgpu") {
			try {
				return await createAsr(spec, "webgpu", spec.webgpu);
			} catch (error) {
				if (!spec.wasm) throw error;
				console.warn("[twitch-cc] WebGPU failed, falling back to wasm", error);
			}
		}
		if (!spec.wasm) {
			throw new Error(
				"this model needs WebGPU with 16-bit float support. Pick a Moonshine model in the Live Captions settings.",
			);
		}
		return createAsr(spec, "wasm", spec.wasm);
	})();
	asrLoads.set(model, promise);
	promise.catch(() => asrLoads.delete(model));
	return promise;
}

function loadVad(): Promise<PreTrainedModel> {
	vadPromise ??= AutoModel.from_pretrained("onnx-community/silero-vad", {
		config: { model_type: "custom" } as never,
		dtype: "fp32",
		device: "wasm",
	});
	vadPromise.catch(() => {
		vadPromise = null;
	});
	return vadPromise;
}

function concat(chunks: Float32Array[], length: number): Float32Array {
	const out = new Float32Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

/**
 * Moonshine is not a streaming model, so speech is segmented with Silero VAD and the growing
 * segment is re-transcribed for interim captions until a pause (or length cap) finalizes it.
 */
export class LocalEngine implements CaptionEngine {
	private models: Models | null = null;
	private stopped = false;
	private pending = new Float32Array(0);
	private processing = false;
	private vadState = new Tensor(
		"float32",
		new Float32Array(2 * 128),
		[2, 1, 128],
	);
	private readonly sampleRate = new Tensor("int64", [SAMPLE_RATE], []);

	private preroll: Float32Array[] = [];
	private segment: Float32Array[] = [];
	private segmentSamples = 0;
	private speaking = false;
	private silenceSamples = 0;
	private segmentId = 0;
	private lastInterimSamples = 0;
	private interimBusy = false;
	private readonly spec: ModelSpec;

	private readonly onProgress: ProgressListener = (progress) => {
		this.emit({
			type: "status",
			state: "loading",
			detail: "Loading caption model",
			progress,
		});
	};

	constructor(
		model: TransformersModel,
		private readonly emit: Emit,
	) {
		this.spec = MODEL_SPECS[model];
		this.emit({
			type: "status",
			state: "loading",
			detail: "Loading caption model…",
		});
		progressListeners.add(this.onProgress);
		Promise.all([loadAsr(model), loadVad()])
			.then(([asr, vad]) => {
				if (this.stopped) return;
				this.models = { asr, vad };
				this.emit({ type: "status", state: "ready" });
			})
			.catch((error: unknown) => {
				console.error("[twitch-cc] model load failed", error);
				this.emit({
					type: "status",
					state: "error",
					detail: `Caption model failed to load: ${error instanceof Error ? error.message : String(error)}`,
				});
			})
			.finally(() => progressListeners.delete(this.onProgress));
	}

	push(pcm: Int16Array<ArrayBuffer>) {
		// Audio that arrives while models load is stale by the time they're ready.
		if (this.stopped || !this.models) return;

		const merged = new Float32Array(this.pending.length + pcm.length);
		merged.set(this.pending);
		for (let i = 0; i < pcm.length; i++) {
			merged[this.pending.length + i] = (pcm[i] ?? 0) / 0x8000;
		}
		this.pending =
			merged.length > MAX_BACKLOG_SAMPLES
				? merged.subarray(merged.length - MAX_BACKLOG_SAMPLES)
				: merged;
		void this.drain();
	}

	stop() {
		this.stopped = true;
		progressListeners.delete(this.onProgress);
	}

	private async drain() {
		if (this.processing) return;
		this.processing = true;
		try {
			while (!this.stopped && this.pending.length >= FRAME_SAMPLES) {
				const frame = this.pending.slice(0, FRAME_SAMPLES);
				this.pending = this.pending.subarray(FRAME_SAMPLES);
				const probability = await this.detectSpeech(frame);
				this.handleFrame(frame, probability);
			}
		} catch (error) {
			console.error("[twitch-cc] VAD failed", error);
		} finally {
			this.processing = false;
		}
	}

	private async detectSpeech(frame: Float32Array): Promise<number> {
		if (!this.models) return 0;
		const { output, stateN } = (await this.models.vad({
			input: new Tensor("float32", frame, [1, FRAME_SAMPLES]),
			sr: this.sampleRate,
			state: this.vadState,
		})) as { output: Tensor; stateN: Tensor };
		this.vadState = stateN;
		return Number(output.data[0]);
	}

	private handleFrame(frame: Float32Array, probability: number) {
		const isSpeech =
			probability > SPEECH_THRESHOLD ||
			(this.speaking && probability >= EXIT_THRESHOLD);

		if (!this.speaking) {
			if (!isSpeech) {
				this.preroll.push(frame);
				if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
				return;
			}
			this.speaking = true;
			this.silenceSamples = 0;
			for (const chunk of this.preroll) this.appendToSegment(chunk);
			this.preroll = [];
		}

		this.appendToSegment(frame);
		this.silenceSamples = isSpeech ? 0 : this.silenceSamples + frame.length;

		if (this.silenceSamples >= END_SILENCE_SAMPLES) {
			this.finalizeSegment();
			this.speaking = false;
		} else if (
			this.segmentSamples >= HARD_MAX_SAMPLES ||
			(this.segmentSamples >= SOFT_MAX_SAMPLES &&
				this.silenceSamples >= SOFT_SILENCE_SAMPLES)
		) {
			this.finalizeSegment();
		} else {
			this.maybeTranscribeInterim();
		}
	}

	private appendToSegment(chunk: Float32Array) {
		this.segment.push(chunk);
		this.segmentSamples += chunk.length;
	}

	private maybeTranscribeInterim() {
		if (
			this.interimBusy ||
			this.segmentSamples < MIN_SEGMENT_SAMPLES ||
			this.segmentSamples - this.lastInterimSamples < INTERIM_STEP_SAMPLES
		) {
			return;
		}
		this.interimBusy = true;
		this.lastInterimSamples = this.segmentSamples;
		const id = this.segmentId;
		this.transcribe(concat(this.segment, this.segmentSamples))
			.then((text) => {
				if (!this.stopped && id === this.segmentId && text) {
					this.emit({ type: "caption", text, final: false });
				}
			})
			.catch((error: unknown) =>
				console.error("[twitch-cc] interim failed", error),
			)
			.finally(() => {
				this.interimBusy = false;
			});
	}

	private finalizeSegment() {
		const audio = concat(this.segment, this.segmentSamples);
		this.segment = [];
		this.segmentSamples = 0;
		this.silenceSamples = 0;
		this.lastInterimSamples = 0;
		this.segmentId++;

		if (audio.length < MIN_SEGMENT_SAMPLES) {
			this.emit({ type: "caption", text: "", final: true });
			return;
		}
		this.transcribe(audio)
			.then((text) => {
				if (!this.stopped) this.emit({ type: "caption", text, final: true });
			})
			.catch((error: unknown) =>
				console.error("[twitch-cc] final failed", error),
			);
	}

	private transcribe(audio: Float32Array): Promise<string> {
		const asr = this.models?.asr;
		if (!asr) return Promise.resolve("");
		const options = generationOptions(this.spec, audio.length);
		const run = asrQueue.then(async () => {
			const output = await asr(audio, options as never);
			const text = Array.isArray(output)
				? (output[0]?.text ?? "")
				: output.text;
			return cleanTranscript(text);
		});
		asrQueue = run.catch(() => undefined);
		return run;
	}
}
