import { expect, test } from "bun:test";
import { LogMelExtractor } from "./log-mel";

// 0.5 s of 440 Hz + 3 kHz tones; expected values come from kaldi-native-fbank with sherpa-onnx's NeMo options.
const SIGNAL = Float32Array.from(
	{ length: 8000 },
	(_, i) =>
		0.5 * Math.sin((2 * Math.PI * 440 * i) / 16000) +
		0.1 * Math.sin((2 * Math.PI * 3000 * i) / 16000),
);
const BINS = [0, 20, 40, 64, 100, 127, 18, 19, 87];
const KALDI: Record<number, number[]> = {
	0: [
		-8.43, -0.8556, -5.7943, -8.5674, -6.6648, -13.7605, 0.1241, 0.4483, 0.384,
	],
	10: [
		-15.7115, -2.0296, -15.9424, -15.9424, -15.9424, -15.9424, 0.8114, 0.4204,
		0.6833,
	],
	48: [
		-15.8578, -2.0295, -15.9424, -15.9424, -15.9424, -15.9424, 0.8114, 0.4204,
		0.6833,
	],
};

test("matches kaldi-native-fbank, including the reflected first frame", () => {
	const frames = new LogMelExtractor().accept(SIGNAL);
	expect(frames).toHaveLength(49);
	for (const [index, expected] of Object.entries(KALDI)) {
		const frame = frames[Number(index)];
		BINS.forEach((bin, i) => {
			expect(frame?.[bin]).toBeCloseTo(expected[i] ?? Number.NaN, 2);
		});
	}
});

test("streaming in uneven chunks yields the same frames as one call", () => {
	const whole = new LogMelExtractor().accept(SIGNAL);
	const extractor = new LogMelExtractor();
	const streamed: Float32Array[] = [];
	for (let start = 0; start < SIGNAL.length; start += 237) {
		streamed.push(...extractor.accept(SIGNAL.subarray(start, start + 237)));
	}
	expect(streamed).toHaveLength(whole.length);
	streamed.forEach((frame, i) => {
		expect(Array.from(frame)).toEqual(Array.from(whole[i] ?? []));
	});
});
