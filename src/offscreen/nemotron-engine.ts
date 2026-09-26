import * as ort from "onnxruntime-web/webgpu";
import type { CaptionLanguage, NemotronModel } from "../shared/settings";
import type { CaptionEngine, Emit } from "./engine";
import { LogMelExtractor, MEL_BINS } from "./log-mel";

// MV3 forbids remote code, so ONNX Runtime's wasm ships inside the extension.
ort.env.wasm.wasmPaths = chrome.runtime.getURL("ort/");
ort.env.wasm.numThreads = 1;

interface ModelFile {
	name: string;
	bytes: number;
}

interface NemotronSpec {
	/** Pinned revision so a repo update can never silently change the model under users. */
	base: string;
	files: {
		encoder: ModelFile;
		encoderData: ModelFile;
		decoder: ModelFile;
		joiner: ModelFile;
		tokens: ModelFile;
	};
	/** Feature frames per encoder call, and how far each call advances. */
	windowFrames: number;
	shiftFrames: number;
	/** Attention-cache length baked into the export. */
	channelCacheFrames: number;
	/** Language prompt ids for models conditioned on a `prompt_index` input. */
	prompts: Record<CaptionLanguage, number> | null;
}

const MODEL_SPECS: Record<NemotronModel, NemotronSpec> = {
	nemotron: {
		base: "https://huggingface.co/mja00/nemotron-speech-streaming-en-0.6b-webgpu/resolve/1a8ebba8c1ea3a074b1748729ab5816a53d140ab/",
		files: {
			encoder: { name: "encoder.q4.onnx", bytes: 42_083_096 },
			encoderData: { name: "encoder.q4.data", bytes: 637_898_752 },
			decoder: { name: "decoder.onnx", bytes: 28_883_664 },
			joiner: { name: "joiner.onnx", bytes: 6_894_757 },
			tokens: { name: "tokens.txt", bytes: 8_952 },
		},
		windowFrames: 65,
		shiftFrames: 56,
		channelCacheFrames: 70,
		prompts: null,
	},
	"nemotron-multilingual": {
		base: "https://huggingface.co/mja00/nemotron-3.5-asr-streaming-0.6b-webgpu/resolve/a46ddaccbd69adbab4b40b31d9a35acf8b8eaede/",
		files: {
			encoder: { name: "encoder.q4.onnx", bytes: 42_296_587 },
			encoderData: { name: "encoder.q4.data", bytes: 640_696_320 },
			decoder: { name: "decoder.onnx", bytes: 59_764_944 },
			joiner: { name: "joiner.onnx", bytes: 37_824_291 },
			tokens: { name: "tokens.txt", bytes: 131_440 },
		},
		windowFrames: 65,
		shiftFrames: 56,
		channelCacheFrames: 56,
		// From the export's `prompt_dictionary` metadata.
		prompts: {
			auto: 101,
			"en-US": 0,
			"en-GB": 1,
			"es-US": 3,
			"es-ES": 2,
			"fr-FR": 8,
			"fr-CA": 100,
			"it-IT": 15,
			"pt-BR": 12,
			"pt-PT": 13,
			"nl-NL": 16,
			"de-DE": 9,
			"tr-TR": 18,
			"ru-RU": 11,
			"ar-AR": 7,
			"hi-IN": 6,
			"ja-JP": 10,
			"ko-KR": 14,
			"vi-VN": 33,
			"uk-UA": 19,
		},
	},
};
const CACHE_NAME = "twitch-cc-models";

const ENCODER_DIM = 1024;
const PREDICTOR_DIM = 640;
const MAX_SYMBOLS_PER_FRAME = 10;
/** If the GPU falls behind by more than this, skip ahead so captions stay live. */
const MAX_BACKLOG_SECONDS = 3;
/** RNNT often emits a word's tail or punctuation just after a pause, so a line only closes after this much silence. */
const LINE_SILENCE_SECONDS = 1.5;
const MIN_SENTENCE_CHARS = 40;
const MAX_UTTERANCE_CHARS = 200;
/** Auto-detect mode appends tags like `<es-ES>` after terminal punctuation; captions don't show them. */
const LANGUAGE_TAG = /^<[a-z]{2,3}-[A-Z]{2}>$/;

interface Model {
	spec: NemotronSpec;
	encoder: ort.InferenceSession;
	decoder: ort.InferenceSession;
	joiner: ort.InferenceSession;
	tokens: string[];
	blank: number;
}

type ProgressListener = (progress: number) => void;

const modelLoads = new Map<NemotronModel, Promise<Model>>();
const progressListeners = new Set<ProgressListener>();
/** ORT sessions are shared by every tab and can't run overlapping calls, so chunks run in FIFO order. */
let inferenceQueue: Promise<unknown> = Promise.resolve();

async function download(
	url: string,
	onBytes: (loaded: number) => void,
): Promise<Uint8Array<ArrayBuffer>> {
	const cache = await caches.open(CACHE_NAME);
	const cached = await cache.match(url);
	if (cached) {
		const bytes = new Uint8Array(await cached.arrayBuffer());
		onBytes(bytes.length);
		return bytes;
	}

	const response = await fetch(url);
	if (!response.ok || !response.body) {
		throw new Error(`${url} download failed (HTTP ${response.status})`);
	}
	const chunks: Uint8Array[] = [];
	let loaded = 0;
	const reader = response.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		loaded += value.length;
		onBytes(loaded);
	}
	const bytes = new Uint8Array(loaded);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	await cache.put(url, new Response(bytes));
	return bytes;
}

async function loadModel(spec: NemotronSpec): Promise<Model> {
	const gpu = (
		navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }
	).gpu;
	if (!(await gpu?.requestAdapter())) {
		throw new Error(
			"Nemotron needs WebGPU. Pick a Moonshine model in the Live Captions settings.",
		);
	}

	const loaded: Record<string, number> = {};
	let total = 0;
	for (const file of Object.values(spec.files)) total += file.bytes;
	const fetchFile = (file: ModelFile) =>
		download(spec.base + file.name, (bytes) => {
			loaded[file.name] = bytes;
			let sum = 0;
			for (const value of Object.values(loaded)) sum += value;
			for (const listener of progressListeners) listener((sum / total) * 100);
		});

	const [encoderGraph, encoderData, decoderGraph, joinerGraph, tokenBytes] =
		await Promise.all([
			fetchFile(spec.files.encoder),
			fetchFile(spec.files.encoderData),
			fetchFile(spec.files.decoder),
			fetchFile(spec.files.joiner),
			fetchFile(spec.files.tokens),
		]);

	void pruneStaleFiles();

	const encoder = await ort.InferenceSession.create(encoderGraph, {
		executionProviders: ["webgpu"],
		externalData: [{ path: spec.files.encoderData.name, data: encoderData }],
	});
	// The predictor and joiner are tiny per-token steps, where GPU dispatch overhead would dominate.
	const decoder = await ort.InferenceSession.create(decoderGraph, {
		executionProviders: ["wasm"],
	});
	const joiner = await ort.InferenceSession.create(joinerGraph, {
		executionProviders: ["wasm"],
	});
	const tokens = new TextDecoder()
		.decode(tokenBytes)
		.split("\n")
		.filter(Boolean)
		.map((line) => line.slice(0, line.lastIndexOf(" ")));

	const model: Model = {
		spec,
		encoder,
		decoder,
		joiner,
		tokens,
		blank: tokens.length - 1,
	};
	// Compiles the WebGPU shaders now; otherwise the first real chunk takes ~1 s instead of ~0.1 s.
	await runEncoder(
		model,
		new Float32Array(MEL_BINS * spec.windowFrames),
		initialEncoderState(spec),
		spec.prompts?.auto ?? null,
	);
	return model;
}

/** Drops files from older pinned revisions, which would otherwise keep hundreds of MB each. */
async function pruneStaleFiles() {
	const current = new Set<string>();
	for (const spec of Object.values(MODEL_SPECS)) {
		for (const file of Object.values(spec.files))
			current.add(spec.base + file.name);
	}
	const cache = await caches.open(CACHE_NAME);
	for (const request of await cache.keys()) {
		if (!current.has(request.url)) await cache.delete(request);
	}
}

function getModel(key: NemotronModel): Promise<Model> {
	const cached = modelLoads.get(key);
	if (cached) return cached;
	const promise = loadModel(MODEL_SPECS[key]);
	modelLoads.set(key, promise);
	promise.catch(() => modelLoads.delete(key));
	return promise;
}

interface EncoderState {
	channel: ort.Tensor;
	time: ort.Tensor;
	length: ort.Tensor;
}

function initialEncoderState(spec: NemotronSpec): EncoderState {
	const cacheFrames = spec.channelCacheFrames;
	return {
		channel: new ort.Tensor(
			"float32",
			new Float32Array(24 * cacheFrames * ENCODER_DIM),
			[1, 24, cacheFrames, ENCODER_DIM],
		),
		time: new ort.Tensor("float32", new Float32Array(24 * ENCODER_DIM * 8), [
			1,
			24,
			ENCODER_DIM,
			8,
		]),
		length: new ort.Tensor("int64", new BigInt64Array(1), [1]),
	};
}

async function runEncoder(
	model: Model,
	features: Float32Array,
	state: EncoderState,
	promptId: number | null,
): Promise<{ frames: Float32Array[]; state: EncoderState }> {
	const window = model.spec.windowFrames;
	const feeds: Record<string, ort.Tensor> = {
		audio_signal: new ort.Tensor("float32", features, [1, MEL_BINS, window]),
		length: new ort.Tensor("int64", BigInt64Array.of(BigInt(window)), [1]),
		cache_last_channel: state.channel,
		cache_last_time: state.time,
		cache_last_channel_len: state.length,
	};
	if (promptId !== null) {
		feeds.prompt_index = new ort.Tensor(
			"int64",
			BigInt64Array.of(BigInt(promptId)),
			[1],
		);
	}
	const out = await model.encoder.run(feeds);
	const encoded = out.outputs;
	const channel = out.cache_last_channel_next;
	const time = out.cache_last_time_next;
	const length = out.cache_last_channel_next_len;
	if (!encoded || !channel || !time || !length) {
		throw new Error("Nemotron encoder returned unexpected outputs");
	}
	// Output is [1, 1024, T]; the joiner wants one [1, 1024, 1] column per time step.
	const data = encoded.data as Float32Array;
	const steps = encoded.dims[2] ?? 0;
	const frames: Float32Array[] = [];
	for (let t = 0; t < steps; t++) {
		const frame = new Float32Array(ENCODER_DIM);
		for (let d = 0; d < ENCODER_DIM; d++) frame[d] = data[d * steps + t] ?? 0;
		frames.push(frame);
	}
	return { frames, state: { channel, time, length } };
}

/**
 * Nemotron is a cache-aware RNNT: each chunk is encoded once, reusing cached context, so
 * captions only ever grow instead of being re-transcribed.
 */
export class NemotronEngine implements CaptionEngine {
	private model: Model | null = null;
	private stopped = false;
	private processing = false;
	private readonly spec: NemotronSpec;
	private readonly promptId: number | null;
	private readonly extractor = new LogMelExtractor();
	private pendingFrames: Float32Array[] = [];
	private encoderState: EncoderState;
	private lstmHidden: ort.Tensor = new ort.Tensor(
		"float32",
		new Float32Array(2 * PREDICTOR_DIM),
		[2, 1, PREDICTOR_DIM],
	);
	private lstmCell: ort.Tensor = new ort.Tensor(
		"float32",
		new Float32Array(2 * PREDICTOR_DIM),
		[2, 1, PREDICTOR_DIM],
	);
	private predictorOut: ort.Tensor | null = null;
	private utterance: number[] = [];
	/** The current line can close once the next word starts. */
	private lineComplete = false;
	private silentChunks = 0;

	private readonly onProgress: ProgressListener = (progress) => {
		this.emit({
			type: "status",
			state: "loading",
			detail: "Loading caption model",
			progress,
		});
	};

	constructor(
		key: NemotronModel,
		language: CaptionLanguage,
		private readonly emit: Emit,
	) {
		this.spec = MODEL_SPECS[key];
		this.promptId = this.spec.prompts?.[language] ?? null;
		this.encoderState = initialEncoderState(this.spec);
		this.emit({
			type: "status",
			state: "loading",
			detail: "Loading caption model…",
		});
		progressListeners.add(this.onProgress);
		getModel(key)
			.then((model) => {
				if (this.stopped) return;
				this.model = model;
				this.emit({ type: "status", state: "ready" });
			})
			.catch((error: unknown) => {
				console.error("[twitch-cc] Nemotron load failed", error);
				this.emit({
					type: "status",
					state: "error",
					detail: `Caption model failed to load: ${error instanceof Error ? error.message : String(error)}`,
				});
			})
			.finally(() => progressListeners.delete(this.onProgress));
	}

	push(pcm: Int16Array<ArrayBuffer>) {
		// Audio that arrives while the model loads is stale by the time it's ready.
		if (this.stopped || !this.model) return;
		const samples = Float32Array.from(pcm, (value) => value / 0x8000);
		this.pendingFrames.push(...this.extractor.accept(samples));
		// Feature frames are 10 ms apart.
		const maxFrames = this.spec.windowFrames + MAX_BACKLOG_SECONDS * 100;
		if (this.pendingFrames.length > maxFrames) {
			this.pendingFrames = this.pendingFrames.slice(-this.spec.windowFrames);
		}
		void this.drain();
	}

	stop() {
		this.stopped = true;
		progressListeners.delete(this.onProgress);
	}

	private async drain() {
		if (this.processing) return;
		this.processing = true;
		const { windowFrames, shiftFrames } = this.spec;
		try {
			while (!this.stopped && this.pendingFrames.length >= windowFrames) {
				const features = new Float32Array(MEL_BINS * windowFrames);
				for (let f = 0; f < windowFrames; f++) {
					const frame = this.pendingFrames[f];
					if (!frame) continue;
					for (let b = 0; b < MEL_BINS; b++) {
						features[b * windowFrames + f] = frame[b] ?? 0;
					}
				}
				this.pendingFrames = this.pendingFrames.slice(shiftFrames);
				const run = inferenceQueue.then(() => this.decodeChunk(features));
				inferenceQueue = run.catch(() => undefined);
				await run;
			}
		} catch (error) {
			console.error("[twitch-cc] Nemotron inference failed", error);
		} finally {
			this.processing = false;
		}
	}

	private async decodeChunk(features: Float32Array) {
		const model = this.model;
		if (!model || this.stopped) return;
		const { frames, state } = await runEncoder(
			model,
			features,
			this.encoderState,
			this.promptId,
		);
		this.encoderState = state;

		let predictorOut =
			this.predictorOut ?? (await this.predict(model, model.blank));
		let newTokens = 0;
		for (const frame of frames) {
			const encoderFrame = new ort.Tensor("float32", frame, [
				1,
				ENCODER_DIM,
				1,
			]);
			for (let symbol = 0; symbol < MAX_SYMBOLS_PER_FRAME; symbol++) {
				const { outputs } = await model.joiner.run({
					encoder_outputs: encoderFrame,
					decoder_outputs: predictorOut,
				});
				const logits = outputs?.data as Float32Array;
				let best = 0;
				for (let k = 1; k < logits.length; k++) {
					if ((logits[k] ?? 0) > (logits[best] ?? 0)) best = k;
				}
				if (best === model.blank) break;
				// Only start a new line on a word start, so trailing pieces and punctuation stay attached.
				if (this.lineComplete && model.tokens[best]?.startsWith("\u2581")) {
					this.finishLine(model);
				}
				this.utterance.push(best);
				newTokens++;
				predictorOut = await this.predict(model, best);
			}
		}
		this.predictorOut = predictorOut;
		if (this.stopped) return;

		if (newTokens === 0) {
			this.silentChunks++;
			this.lineComplete = true;
			const silentSeconds = (this.silentChunks * this.spec.shiftFrames) / 100;
			if (silentSeconds >= LINE_SILENCE_SECONDS) this.finishLine(model);
			return;
		}
		this.silentChunks = 0;
		const text = this.utteranceText(model);
		this.emit({ type: "caption", text, final: false });
		if (
			(text.length >= MIN_SENTENCE_CHARS && /[.?!。？！]$/.test(text)) ||
			text.length >= MAX_UTTERANCE_CHARS
		) {
			this.lineComplete = true;
		}
	}

	private finishLine(model: Model) {
		const text = this.utteranceText(model);
		if (text) this.emit({ type: "caption", text, final: true });
		this.utterance = [];
		this.lineComplete = false;
	}

	private async predict(model: Model, token: number): Promise<ort.Tensor> {
		const out = await model.decoder.run({
			targets: new ort.Tensor("int32", Int32Array.of(token), [1, 1]),
			target_length: new ort.Tensor("int32", Int32Array.of(1), [1]),
			"states.1": this.lstmHidden,
			"onnx::Slice_3": this.lstmCell,
		});
		const output = out.outputs;
		const hidden = out.states;
		// The export leaves the LSTM cell-state output with an auto-generated name.
		const cell = out["162"];
		if (!output || !hidden || !cell) {
			throw new Error("Nemotron decoder returned unexpected outputs");
		}
		this.lstmHidden = hidden;
		this.lstmCell = cell;
		return output;
	}

	private utteranceText(model: Model): string {
		let text = "";
		for (const id of this.utterance) {
			const piece = model.tokens[id];
			if (!piece || piece === "<unk>" || LANGUAGE_TAG.test(piece)) continue;
			text += piece;
		}
		return text.replaceAll("\u2581", " ").replace(/\s+/g, " ").trim();
	}
}
