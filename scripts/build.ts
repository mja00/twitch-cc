import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const src = join(root, "src");

async function bundle(config: Parameters<typeof Bun.build>[0]) {
	const result = await Bun.build({
		target: "browser",
		outdir: dist,
		minify: true,
		sourcemap: "linked",
		naming: { entry: "[name].[ext]", chunk: "chunks/[name]-[hash].[ext]" },
		...config,
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		process.exit(1);
	}
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// Content scripts and worklets can't load ES module chunks, so they are bundled standalone.
await bundle({ entrypoints: [join(src, "content.ts")], format: "iife" });
await bundle({ entrypoints: [join(src, "audio-worklet.ts")], format: "esm" });
await bundle({
	entrypoints: [
		join(src, "background.ts"),
		join(src, "offscreen.ts"),
		join(src, "settings.ts"),
	],
	format: "esm",
	splitting: true,
});

await cp(join(root, "static"), dist, { recursive: true });

const ortDist = join(root, "node_modules/onnxruntime-web/dist");
await mkdir(join(dist, "ort"));
for (const file of [
	"ort-wasm-simd-threaded.asyncify.mjs",
	"ort-wasm-simd-threaded.asyncify.wasm",
]) {
	await cp(join(ortDist, file), join(dist, "ort", file));
}

console.log(`Built extension to ${dist}`);
