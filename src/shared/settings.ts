export type Engine = "local" | "deepgram";
/** Models run through Transformers.js pipelines with VAD segmentation. */
export type TransformersModel = "cohere" | "base" | "tiny";
/** Cache-aware streaming RNNT models run directly on ONNX Runtime Web. */
export type NemotronModel = "nemotron" | "nemotron-multilingual";
export type LocalModel = TransformersModel | NemotronModel;
/** Transcription-ready locales of Nemotron 3.5, plus automatic detection. */
export type CaptionLanguage =
	| "auto"
	| "en-US"
	| "en-GB"
	| "es-US"
	| "es-ES"
	| "fr-FR"
	| "fr-CA"
	| "it-IT"
	| "pt-BR"
	| "pt-PT"
	| "nl-NL"
	| "de-DE"
	| "tr-TR"
	| "ru-RU"
	| "ar-AR"
	| "hi-IN"
	| "ja-JP"
	| "ko-KR"
	| "vi-VN"
	| "uk-UA";
export type DeepgramModel = "nova-3" | "nova-2";
export type FontFamily =
	| "proportional-sans"
	| "monospace-sans"
	| "proportional-serif"
	| "monospace-serif"
	| "casual"
	| "small-caps";
export type EdgeStyle =
	| "none"
	| "drop-shadow"
	| "raised"
	| "depressed"
	| "outline";
export type Position = "bottom" | "top";

export interface Settings {
	autoEnable: boolean;
	engine: Engine;
	localModel: LocalModel;
	/** Only used by the multilingual model. */
	captionLanguage: CaptionLanguage;
	deepgramApiKey: string;
	deepgramModel: DeepgramModel;
	fontFamily: FontFamily;
	/** Percent of the default size. */
	fontSize: number;
	textColor: string;
	/** 0-100 */
	textOpacity: number;
	backgroundColor: string;
	/** 0-100 */
	backgroundOpacity: number;
	edgeStyle: EdgeStyle;
	position: Position;
	maxLines: number;
	/** Seconds of silence before captions are cleared. */
	hideAfter: number;
}

export const DEFAULT_SETTINGS: Settings = {
	autoEnable: false,
	engine: "local",
	localModel: "cohere",
	captionLanguage: "auto",
	deepgramApiKey: "",
	deepgramModel: "nova-3",
	fontFamily: "proportional-sans",
	fontSize: 100,
	textColor: "#ffffff",
	textOpacity: 100,
	backgroundColor: "#080808",
	backgroundOpacity: 75,
	edgeStyle: "none",
	position: "bottom",
	maxLines: 2,
	hideAfter: 4,
};

/** Keys whose change requires restarting the transcription session. */
export const ENGINE_KEYS: readonly (keyof Settings)[] = [
	"engine",
	"localModel",
	"captionLanguage",
	"deepgramApiKey",
	"deepgramModel",
];

export async function loadSettings(): Promise<Settings> {
	const stored = await chrome.storage.local.get<Settings>(DEFAULT_SETTINGS);
	return { ...DEFAULT_SETTINGS, ...stored };
}

export function onSettingsChanged(
	listener: (settings: Settings, changedKeys: (keyof Settings)[]) => void,
): void {
	chrome.storage.onChanged.addListener(async (changes, area) => {
		if (area !== "local") return;
		const keys = Object.keys(changes).filter(
			(key): key is keyof Settings => key in DEFAULT_SETTINGS,
		);
		if (keys.length === 0) return;
		listener(await loadSettings(), keys);
	});
}
