import type { BackgroundMessage } from "./shared/messages";

let creating: Promise<void> | null = null;

async function ensureOffscreen() {
	if (await chrome.offscreen.hasDocument()) return;
	creating ??= chrome.offscreen
		.createDocument({
			url: "offscreen.html",
			reasons: [chrome.offscreen.Reason.WORKERS],
			justification:
				"Runs speech recognition for live captions outside the Twitch page.",
		})
		.finally(() => {
			creating = null;
		});
	await creating;
}

chrome.runtime.onMessage.addListener(
	(message: BackgroundMessage, _sender, sendResponse) => {
		if (message.type === "ensure-offscreen") {
			ensureOffscreen().then(
				() => sendResponse({ ok: true }),
				(error: unknown) => sendResponse({ ok: false, error: String(error) }),
			);
			return true;
		}
		if (message.type === "offscreen-idle") {
			void chrome.offscreen.closeDocument().catch(() => undefined);
		}
		return false;
	},
);
