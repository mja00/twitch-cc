const CC_ICON_PATH =
	"M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Zm0 14H5V6h14v12ZM7 15h3a1 1 0 0 0 1-1v-1H9.5v.5h-2v-3h2v.5H11v-1a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1Zm7 0h3a1 1 0 0 0 1-1v-1h-1.5v.5h-2v-3h2v.5H18v-1a1 1 0 0 0-1-1h-3a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1Z";

/**
 * Keeps a CC toggle in Twitch's player control bar. The button is cloned from Twitch's own
 * fullscreen button so it inherits the player's hashed styled-component classes.
 */
export function ensurePlayerButton(
	host: HTMLElement,
	pressed: boolean,
	onToggle: () => void,
) {
	const group = host.querySelector<HTMLElement>(
		".player-controls__right-control-group",
	);
	if (!group) return;

	let button = group.querySelector<HTMLButtonElement>(".tcc-button");
	if (!button) {
		const template = group
			.querySelector('[data-a-target="player-fullscreen-button"]')
			?.closest(".player-controls__right-control-group > *");
		if (!template) return;

		const wrapper = template.cloneNode(true) as HTMLElement;
		button = wrapper.querySelector("button");
		const svg = wrapper.querySelector("svg");
		if (!button || !svg) return;

		button.classList.add("tcc-button");
		button.removeAttribute("data-a-target");
		button.removeAttribute("aria-haspopup");
		button.setAttribute("aria-label", "Live captions (c)");
		button.title = "Live captions";
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.replaceChildren();
		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("d", CC_ICON_PATH);
		svg.append(path);
		button.addEventListener("click", (event) => {
			event.stopPropagation();
			onToggle();
		});

		const anchor =
			group
				.querySelector('[data-a-target="player-settings-button"]')
				?.closest(".player-controls__right-control-group > *") ?? template;
		group.insertBefore(wrapper, anchor);
	}

	button.setAttribute("aria-pressed", String(pressed));
}
