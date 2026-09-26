import { applyCaptionStyle } from "../shared/caption-style";
import type { Settings } from "../shared/settings";

/** Older finalized text is dropped past this length; only the last few lines are visible anyway. */
const MAX_TRANSCRIPT_CHARS = 320;

export type StatusKind = "info" | "error";

export class CaptionOverlay {
	readonly root = document.createElement("div");
	private readonly status = document.createElement("div");
	private readonly text = document.createElement("div");
	private readonly cue = document.createElement("span");
	private finals: string[] = [];
	private interim = "";
	private hideAfterMs = 0;
	private hideTimer: number | undefined;

	constructor(settings: Settings) {
		this.root.className = "tcc-overlay";
		this.root.setAttribute("aria-live", "polite");
		const captionWindow = document.createElement("div");
		captionWindow.className = "tcc-window";
		this.status.className = "tcc-status";
		this.text.className = "tcc-text";
		this.cue.className = "tcc-cue";
		const block = document.createElement("div");
		block.append(this.cue);
		this.text.append(block);
		captionWindow.append(this.status, this.text);
		this.root.append(captionWindow);
		this.applySettings(settings);
		this.render();
		this.setStatus(null);
	}

	applySettings(settings: Settings) {
		applyCaptionStyle(this.root, settings);
		this.hideAfterMs = settings.hideAfter * 1000;
	}

	showCaption(text: string, final: boolean) {
		const trimmed = text.trim();
		if (final) {
			this.interim = "";
			if (trimmed) this.finals.push(trimmed);
			let length = this.finals.join(" ").length;
			while (length > MAX_TRANSCRIPT_CHARS && this.finals.length > 1) {
				length -= (this.finals.shift()?.length ?? 0) + 1;
			}
		} else {
			this.interim = trimmed;
		}
		this.render();

		clearTimeout(this.hideTimer);
		this.hideTimer = window.setTimeout(() => this.clear(), this.hideAfterMs);
	}

	setStatus(message: string | null, kind: StatusKind = "info") {
		this.status.hidden = !message;
		this.status.textContent = message ?? "";
		this.status.dataset.kind = kind;
	}

	clear() {
		clearTimeout(this.hideTimer);
		this.finals = [];
		this.interim = "";
		this.render();
	}

	destroy() {
		clearTimeout(this.hideTimer);
		this.root.remove();
	}

	private render() {
		let content = "";
		for (const part of [...this.finals, this.interim]) {
			if (!part) continue;
			// Streaming models can emit a comma or period after the line it belongs to has closed.
			const attaches = content === "" || /^[,.!?;:…、。，！？]/.test(part);
			content += attaches ? part : ` ${part}`;
		}
		this.cue.textContent = content;
		this.text.hidden = content.length === 0;
	}
}
