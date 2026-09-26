import { applyCaptionStyle } from "./shared/caption-style";
import type { TabMessage, TabState } from "./shared/messages";
import {
	DEFAULT_SETTINGS,
	loadSettings,
	onSettingsChanged,
	type Settings,
} from "./shared/settings";

const APPEARANCE_KEYS: (keyof Settings)[] = [
	"fontFamily",
	"fontSize",
	"textColor",
	"textOpacity",
	"backgroundColor",
	"backgroundOpacity",
	"edgeStyle",
	"position",
	"maxLines",
	"hideAfter",
];

function requireElement<T extends Element>(selector: string): T {
	const element = document.querySelector<T>(selector);
	if (!element) throw new Error(`settings.html is missing ${selector}`);
	return element;
}

const form = requireElement<HTMLFormElement>("#settings");
const preview = requireElement<HTMLElement>("#preview-overlay");
const tabToggle = requireElement<HTMLInputElement>("#tab-toggle");
const tabStatus = requireElement<HTMLElement>("#tab-status");

if (new URLSearchParams(location.search).get("view") === "options") {
	document.body.classList.add("options");
}

function render(settings: Settings) {
	const fields = form.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
		"input[name], select[name]",
	);
	for (const field of fields) {
		const value = settings[field.name as keyof Settings];
		if (field instanceof HTMLInputElement && field.type === "checkbox") {
			field.checked = Boolean(value);
		} else if (document.activeElement !== field) {
			// Leave a focused field alone so typing isn't interrupted by its own storage echo.
			field.value = String(value);
		}
	}
	for (const output of form.querySelectorAll<HTMLOutputElement>(
		"output[data-for]",
	)) {
		const key = output.dataset.for as keyof Settings;
		output.value = `${settings[key]}${output.dataset.unit ?? ""}`;
	}
	form.dataset.engine = settings.engine;
	applyCaptionStyle(preview, settings);
}

function readField(field: HTMLInputElement | HTMLSelectElement): unknown {
	if (field instanceof HTMLInputElement) {
		if (field.type === "checkbox") return field.checked;
		if (field.type === "range") return Number(field.value);
		if (field.type === "password") return field.value.trim();
	}
	return field.value;
}

form.addEventListener("input", (event) => {
	const field = event.target;
	if (
		!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)
	) {
		return;
	}
	if (!field.name) return;
	void chrome.storage.local.set({ [field.name]: readField(field) });
});

document.querySelector("#reset-appearance")?.addEventListener("click", () => {
	const defaults = Object.fromEntries(
		APPEARANCE_KEYS.map((key) => [key, DEFAULT_SETTINGS[key]]),
	);
	void chrome.storage.local.set(defaults);
});

async function sendToTab(message: TabMessage): Promise<TabState | null> {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (tab?.id === undefined) return null;
	const tabId = tab.id;
	try {
		return await chrome.tabs.sendMessage<TabMessage, TabState>(tabId, message, {
			frameId: 0,
		});
	} catch {
		// No content script in this tab, i.e. it isn't a Twitch page.
		return null;
	}
}

function renderTabState(state: TabState | null) {
	tabToggle.disabled = !state?.hasPlayer;
	tabToggle.checked = state?.enabled ?? false;
	if (!state) {
		tabStatus.textContent = "Open a Twitch stream to use captions.";
	} else if (!state.hasPlayer) {
		tabStatus.textContent = "No video player on this page.";
	} else if (state.status) {
		tabStatus.textContent = state.status;
	} else {
		tabStatus.textContent = state.enabled ? "Captions on" : "Captions off";
	}
}

tabToggle.addEventListener("change", async () => {
	renderTabState(
		await sendToTab({ type: "set-enabled", enabled: tabToggle.checked }),
	);
});

render(await loadSettings());
onSettingsChanged((settings) => render(settings));

if (!document.body.classList.contains("options")) {
	renderTabState(await sendToTab({ type: "get-state" }));
	// Model downloads report progress through the tab's status, so keep it fresh while the popup is open.
	window.setInterval(
		async () => renderTabState(await sendToTab({ type: "get-state" })),
		1000,
	);
}
