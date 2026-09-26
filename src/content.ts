import { CaptionSession } from "./content/caption-session";
import { CaptionOverlay } from "./content/overlay";
import { ensurePlayerButton } from "./content/player-button";
import type {
	EngineConfig,
	EngineStatus,
	TabMessage,
	TabState,
} from "./shared/messages";
import {
	ENGINE_KEYS,
	loadSettings,
	onSettingsChanged,
	type Settings,
} from "./shared/settings";

/** Twitch is a SPA that swaps players on navigation, so the player is re-discovered on an interval. */
const PLAYER_POLL_MS = 1000;

interface Player {
	video: HTMLVideoElement;
	host: HTMLElement;
	overlay: CaptionOverlay;
}

let settings: Settings;
let enabled = false;
let player: Player | null = null;
let session: CaptionSession | null = null;
let engineStatus: EngineStatus = { state: "ready" };
let suspended = false;

function findVideo(): HTMLVideoElement | null {
	let best: HTMLVideoElement | null = null;
	let bestArea = 0;
	for (const video of document.querySelectorAll("video")) {
		const area = video.offsetWidth * video.offsetHeight;
		if (area > bestArea) {
			best = video;
			bestArea = area;
		}
	}
	return best;
}

function engineConfig(): EngineConfig {
	if (settings.engine === "deepgram") {
		return {
			engine: "deepgram",
			apiKey: settings.deepgramApiKey,
			model: settings.deepgramModel,
		};
	}
	return {
		engine: "local",
		model: settings.localModel,
		language: settings.captionLanguage,
	};
}

function statusText(): string {
	if (!enabled) return "";
	if (engineStatus.state === "error") return engineStatus.detail;
	if (suspended) return "Click the page to start live captions";
	if (engineStatus.state === "loading") {
		if (engineStatus.progress === undefined) return engineStatus.detail;
		return `${engineStatus.detail} ${Math.round(engineStatus.progress)}%`;
	}
	return "";
}

function renderStatus() {
	const text = statusText();
	player?.overlay.setStatus(
		text || null,
		engineStatus.state === "error" ? "error" : "info",
	);
}

function startSession() {
	if (!player || session) return;
	if (settings.engine === "deepgram" && !settings.deepgramApiKey) {
		engineStatus = {
			state: "error",
			detail: "Add a Deepgram API key in the Live Captions settings.",
		};
		renderStatus();
		return;
	}
	const overlay = player.overlay;
	session = new CaptionSession(player.video, engineConfig(), {
		onCaption: (text, final) => overlay.showCaption(text, final),
		onStatus: (status) => {
			engineStatus = status;
			renderStatus();
		},
		onSuspended: (value) => {
			suspended = value;
			renderStatus();
		},
	});
	void session.open();
}

function stopSession() {
	session?.close();
	session = null;
	engineStatus = { state: "ready" };
	suspended = false;
	player?.overlay.clear();
	renderStatus();
}

function setEnabled(value: boolean) {
	enabled = value;
	if (enabled) startSession();
	else stopSession();
	syncPlayer();
}

function toggle() {
	setEnabled(!enabled);
}

function detachPlayer() {
	if (!player) return;
	stopSession();
	player.overlay.destroy();
	player.host.classList.remove("tcc-host");
	player = null;
}

function attachPlayer(video: HTMLVideoElement) {
	const host =
		video.closest<HTMLElement>(".video-player__container") ??
		video.parentElement;
	if (!host) return;
	player = { video, host, overlay: new CaptionOverlay(settings) };
	if (enabled) startSession();
}

/** Re-mounts pieces React may have discarded and follows player swaps. */
function syncPlayer() {
	const video = findVideo();
	if (video !== player?.video) {
		detachPlayer();
		if (video) attachPlayer(video);
	}
	if (!player) return;

	const { host, overlay, video: current } = player;
	host.classList.add("tcc-host");
	if (getComputedStyle(host).position === "static") {
		host.style.position = "relative";
	}
	if (!overlay.root.isConnected) {
		// Sit directly above the video but below Twitch's controls so menus stay on top.
		const videoWrapper =
			current.parentElement === host ? current : current.parentElement;
		videoWrapper?.after(overlay.root);
	}
	ensurePlayerButton(host, enabled, toggle);
	renderStatus();
}

function isTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	return (
		target.isContentEditable ||
		target.tagName === "INPUT" ||
		target.tagName === "TEXTAREA" ||
		target.tagName === "SELECT"
	);
}

async function main() {
	settings = await loadSettings();
	enabled = settings.autoEnable;

	onSettingsChanged((next, changed) => {
		settings = next;
		player?.overlay.applySettings(next);
		if (enabled && changed.some((key) => ENGINE_KEYS.includes(key))) {
			stopSession();
			startSession();
		}
	});

	chrome.runtime.onMessage.addListener(
		(message: TabMessage, _sender, sendResponse) => {
			if (message.type === "set-enabled") setEnabled(message.enabled);
			const state: TabState = {
				enabled,
				hasPlayer: player !== null,
				status: statusText(),
			};
			sendResponse(state);
		},
	);

	// Twitch's native captions own plain "c", so ours is Shift+C, caught before Twitch sees it.
	document.addEventListener(
		"keydown",
		(event) => {
			if (
				event.key.toLowerCase() !== "c" ||
				!event.shiftKey ||
				event.ctrlKey ||
				event.metaKey ||
				event.altKey
			) {
				return;
			}
			if (isTypingTarget(event.target) || !player) return;
			event.stopPropagation();
			toggle();
		},
		true,
	);

	syncPlayer();
	window.setInterval(syncPlayer, PLAYER_POLL_MS);
}

void main();
