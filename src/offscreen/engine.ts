import type { ServerMessage } from "../shared/messages";

export type Emit = (message: ServerMessage) => void;

/** One transcription stream, owned by a single content-script port. */
export interface CaptionEngine {
	/** 16 kHz mono PCM. */
	push(pcm: Int16Array<ArrayBuffer>): void;
	stop(): void;
}
