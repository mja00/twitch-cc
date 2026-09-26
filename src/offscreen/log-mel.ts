export const MEL_BINS = 128;

const HOP = 160;
const WINDOW = 400;
const FFT_SIZE = 512;
const SPECTRUM_BINS = FFT_SIZE / 2 + 1;
const PREEMPHASIS = 0.97;
const FLT_EPSILON = 1.1920929e-7;
/** Kaldi centres frame f on sample f * HOP + HOP / 2 when snip_edges is off. */
const FIRST_SAMPLE_OFFSET = HOP / 2 - WINDOW / 2;

const HANN = Float32Array.from(
	{ length: WINDOW },
	(_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WINDOW),
);

const BIT_REVERSED = Uint16Array.from({ length: FFT_SIZE }, (_, i) => {
	let reversed = 0;
	for (let bit = 0; bit < 9; bit++) reversed |= ((i >> bit) & 1) << (8 - bit);
	return reversed;
});
const TWIDDLE_COS = Float32Array.from({ length: FFT_SIZE / 2 }, (_, k) =>
	Math.cos((-2 * Math.PI * k) / FFT_SIZE),
);
const TWIDDLE_SIN = Float32Array.from({ length: FFT_SIZE / 2 }, (_, k) =>
	Math.sin((-2 * Math.PI * k) / FFT_SIZE),
);

function melScale(hz: number): number {
	return hz <= 1000
		? (hz * 3) / 200
		: 15 + 14.545078505785561 * Math.log(hz / 1000);
}

function inverseMelScale(mel: number): number {
	return mel <= 15
		? (200 / 3) * mel
		: 1000 * Math.exp((mel - 15) * 0.06875177742094911);
}

interface MelBank {
	first: number;
	weights: Float32Array;
}

/** Slaney-scale, Slaney-normalised triangular filters from 0 to 8 kHz, as librosa builds them. */
const MEL_BANKS: MelBank[] = (() => {
	const low = melScale(0);
	const delta = (melScale(8000) - low) / (MEL_BINS + 1);
	const banks: MelBank[] = [];
	for (let bin = 0; bin < MEL_BINS; bin++) {
		const left = inverseMelScale(low + bin * delta);
		const center = inverseMelScale(low + (bin + 1) * delta);
		const right = inverseMelScale(low + (bin + 2) * delta);
		const weights: number[] = [];
		let first = -1;
		for (let i = 0; i < SPECTRUM_BINS; i++) {
			const hz = (i * 16000) / FFT_SIZE;
			if (hz <= left || hz >= right) continue;
			if (first < 0) first = i;
			const slope =
				hz <= center
					? (hz - left) / (center - left)
					: (right - hz) / (right - center);
			weights.push((slope * 2) / (right - left));
		}
		banks.push({ first, weights: Float32Array.from(weights) });
	}
	return banks;
})();

/**
 * Incremental 16 kHz log-Mel features matching kaldi-native-fbank with sherpa-onnx's NeMo options,
 * which is what the Nemotron streaming encoder was exported against.
 */
export class LogMelExtractor {
	private samples = new Float32Array(0);
	/** Absolute stream index of `samples[0]`. */
	private offset = 0;
	private nextFrame = 0;
	private readonly real = new Float32Array(FFT_SIZE);
	private readonly imag = new Float32Array(FFT_SIZE);

	/** Returns every frame that the audio received so far fully covers. */
	accept(chunk: Float32Array): Float32Array[] {
		const merged = new Float32Array(this.samples.length + chunk.length);
		merged.set(this.samples);
		merged.set(chunk, this.samples.length);
		this.samples = merged;

		const frames: Float32Array[] = [];
		const available = this.offset + this.samples.length;
		while (this.nextFrame * HOP + FIRST_SAMPLE_OFFSET + WINDOW <= available) {
			frames.push(
				this.computeFrame(this.nextFrame * HOP + FIRST_SAMPLE_OFFSET),
			);
			this.nextFrame++;
		}

		const keepFrom = Math.max(0, this.nextFrame * HOP + FIRST_SAMPLE_OFFSET);
		if (keepFrom > this.offset) {
			this.samples = this.samples.slice(keepFrom - this.offset);
			this.offset = keepFrom;
		}
		return frames;
	}

	private computeFrame(start: number): Float32Array {
		const { real, imag } = this;
		real.fill(0);
		imag.fill(0);
		for (let s = 0; s < WINDOW; s++) {
			let index = start + s;
			// Only the first frame reaches before the stream start; Kaldi reflects it (-1 -> 0).
			if (index < 0) index = -index - 1;
			real[s] = this.samples[index - this.offset] ?? 0;
		}
		for (let s = WINDOW - 1; s > 0; s--) {
			real[s] = (real[s] ?? 0) - PREEMPHASIS * (real[s - 1] ?? 0);
		}
		real[0] = (real[0] ?? 0) * (1 - PREEMPHASIS);
		for (let s = 0; s < WINDOW; s++) real[s] = (real[s] ?? 0) * (HANN[s] ?? 0);

		this.fft();

		const frame = new Float32Array(MEL_BINS);
		for (let bin = 0; bin < MEL_BINS; bin++) {
			const bank = MEL_BANKS[bin];
			if (!bank) continue;
			let energy = 0;
			for (let k = 0; k < bank.weights.length; k++) {
				const i = bank.first + k;
				energy +=
					(bank.weights[k] ?? 0) * ((real[i] ?? 0) ** 2 + (imag[i] ?? 0) ** 2);
			}
			frame[bin] = Math.log(Math.max(energy, FLT_EPSILON));
		}
		return frame;
	}

	/** In-place iterative radix-2 FFT over `real`/`imag`. */
	private fft() {
		const { real, imag } = this;
		for (let i = 0; i < FFT_SIZE; i++) {
			const j = BIT_REVERSED[i] ?? 0;
			if (j <= i) continue;
			const re = real[i] ?? 0;
			real[i] = real[j] ?? 0;
			real[j] = re;
		}
		for (let size = 2; size <= FFT_SIZE; size *= 2) {
			const half = size / 2;
			const stride = FFT_SIZE / size;
			for (let start = 0; start < FFT_SIZE; start += size) {
				for (let k = 0; k < half; k++) {
					const cos = TWIDDLE_COS[k * stride] ?? 0;
					const sin = TWIDDLE_SIN[k * stride] ?? 0;
					const a = start + k;
					const b = a + half;
					const br = real[b] ?? 0;
					const bi = imag[b] ?? 0;
					const tr = br * cos - bi * sin;
					const ti = br * sin + bi * cos;
					const ar = real[a] ?? 0;
					const ai = imag[a] ?? 0;
					real[b] = ar - tr;
					imag[b] = ai - ti;
					real[a] = ar + tr;
					imag[a] = ai + ti;
				}
			}
		}
	}
}
