import type { FontFamily, Settings } from "./settings";

const FONT_STACKS: Record<FontFamily, string> = {
	"proportional-sans":
		'"Inter", "Roobert", "Helvetica Neue", Helvetica, Arial, sans-serif',
	"monospace-sans": 'Menlo, Consolas, "DejaVu Sans Mono", monospace',
	"proportional-serif": 'Georgia, "Times New Roman", serif',
	"monospace-serif": '"Courier New", Courier, monospace',
	casual: '"Comic Sans MS", "Chalkboard SE", "Comic Neue", cursive',
	"small-caps": '"Helvetica Neue", Helvetica, Arial, sans-serif',
};

function toRgba(hex: string, opacityPercent: number): string {
	const value = Number.parseInt(hex.replace("#", ""), 16);
	const r = (value >> 16) & 255;
	const g = (value >> 8) & 255;
	const b = value & 255;
	return `rgba(${r}, ${g}, ${b}, ${opacityPercent / 100})`;
}

/** Applies appearance settings to a `.tcc-overlay` element via CSS variables consumed by content.css. */
export function applyCaptionStyle(overlay: HTMLElement, settings: Settings) {
	const style = overlay.style;
	style.setProperty("--tcc-font", FONT_STACKS[settings.fontFamily]);
	style.setProperty("--tcc-scale", String(settings.fontSize / 100));
	style.setProperty(
		"--tcc-color",
		toRgba(settings.textColor, settings.textOpacity),
	);
	style.setProperty(
		"--tcc-bg",
		toRgba(settings.backgroundColor, settings.backgroundOpacity),
	);
	style.setProperty("--tcc-lines", String(settings.maxLines));
	overlay.dataset.edge = settings.edgeStyle;
	overlay.dataset.position = settings.position;
	overlay.dataset.smallCaps = String(settings.fontFamily === "small-caps");
}
