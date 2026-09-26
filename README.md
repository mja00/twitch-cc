# Twitch Live Captions

A Chromium extension (Helium, Chrome, Edge, Brave) that adds realtime English captions to any Twitch stream, VOD, or embedded player. Captions render over the video like normal closed captions, with YouTube-style appearance settings.

## Features

- **On-device transcription by default.** Speech recognition runs locally on your GPU through WebGPU. No account, no API key, and no audio leaves your machine.
- **Optional Deepgram engine.** Stream audio to Deepgram Nova-3 or Nova-2 with your own API key for the lowest latency.
- **Native-feeling captions.** A CC button in the Twitch player, a <kbd>c</kbd> shortcut, and captions that lift above the control bar and follow fullscreen, theatre mode, the mini-player, and channel switches.
- **Works when muted.** Audio is read from the video element, so you can mute the stream and still read along.
- **Caption settings.** Font, size, text color and opacity, background color and opacity, character edge (drop shadow, raised, depressed, outline), top or bottom position, 1 to 4 lines, and how long captions linger after speech stops, all with a live preview.

## Models

| Engine | Model | Download | Notes |
| --- | --- | --- | --- |
| On-device (default) | [Cohere Transcribe 03-2026](https://huggingface.co/CohereLabs/cohere-transcribe-03-2026) | ~1.5 GB | Most accurate (5.4% average WER on the Open ASR Leaderboard). Needs WebGPU with 16-bit float support. |
| On-device | [Moonshine Base](https://huggingface.co/onnx-community/moonshine-base-ONNX) | ~155 MB | Lighter, runs on older GPUs or the CPU fallback. |
| On-device | [Moonshine Tiny](https://huggingface.co/onnx-community/moonshine-tiny-ONNX) | ~80 MB | Fastest and smallest. |
| Deepgram | Nova-3 / Nova-2 | none | Cloud, billed to your Deepgram account. |

Models download from Hugging Face on first use and are cached by the browser. On an Apple Silicon Mac, Cohere Transcribe takes roughly 300 to 700 ms per update and loads from cache in a few seconds.

## Requirements

- A Chromium-based browser, version 124 or newer.
- For Cohere Transcribe: a GPU exposed through WebGPU with the `shader-f16` feature (most GPUs from the last several years).
- [Bun](https://bun.sh), only if you build from source.

## Install

1. Download `twitch-live-captions-vX.Y.Z.zip` from the [latest release](https://github.com/mja00/twitch-cc/releases/latest) and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the unzipped folder.
4. Open a Twitch stream and click the **CC** button in the player, or press <kbd>c</kbd>.

To update, unzip the new release over the same folder, click the reload icon on the extension card, and refresh the Twitch tab.

### From source

```sh
git clone https://github.com/mja00/twitch-cc.git
cd twitch-cc
bun install
bun run build
```

Then load the `dist/` folder with **Load unpacked** as above.

## Usage

- **Toggle captions:** the CC button in the player controls, the <kbd>c</kbd> key, or the switch in the toolbar popup.
- **Settings:** click the extension's toolbar icon, or open its options page for a full-size view.
- The first time you enable captions, the overlay shows model download progress. Later loads come from the cache.
- Ads play through the same player, so they get captioned too.

## Privacy

With an on-device engine, audio is processed entirely in the browser; only the model files are downloaded from Hugging Face. With Deepgram, stream audio is sent to Deepgram's API using the key you provide. Settings, including the API key, are stored in `chrome.storage.local` on your machine.

The extension requests only the `storage` and `offscreen` permissions and runs on `*.twitch.tv`.

## Development

```sh
bun run build      # bundle to dist/
bun run lint       # Biome, with fixes
bun run typecheck  # TypeScript
bun test           # unit tests
```

| Piece | Files | Role |
| --- | --- | --- |
| Content script | `src/content.ts`, `src/content/*` | Finds the player, draws the overlay and CC button, and captures audio. An AudioWorklet (`src/audio-worklet.ts`) resamples it to 16 kHz PCM. |
| Offscreen document | `src/offscreen.ts`, `src/offscreen/*` | Runs one transcription engine per tab: Silero VAD plus Cohere or Moonshine, or a Deepgram WebSocket. Closes after 5 idle minutes to free GPU memory. |
| Service worker | `src/background.ts` | Creates and closes the offscreen document. |
| Settings | `src/settings.ts`, `static/settings.html` | Popup and options page backed by `chrome.storage.local`. |

The on-device engines are not natively streaming. Speech is segmented with Silero VAD, and the growing segment is re-transcribed for interim captions until a pause finalizes it.

### Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please) and rely on [Conventional Commits](https://www.conventionalcommits.org/). Each push to `main` updates a release PR that bumps the version in `package.json` and `static/manifest.json` and updates `CHANGELOG.md`. Merging that PR tags the release, and CI attaches the built extension zip.

## License

[MIT](LICENSE). Model weights are downloaded at runtime and carry their own licenses: Cohere Transcribe is Apache-2.0, and Moonshine and Silero VAD are MIT. This project is not affiliated with Twitch.
