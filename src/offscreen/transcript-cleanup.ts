const MAX_PHRASE_WORDS = 6;

function normalize(word: string): string {
	return word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
}

/**
 * Collapses decoder loops like "it looks like it looks like it looks like" to one occurrence.
 * Single words need four repeats because people really do say "no no no".
 */
function collapseRepeats(text: string): string {
	const words = text.split(/\s+/).filter(Boolean);
	const keys = words.map(normalize);

	for (let size = 1; size <= MAX_PHRASE_WORDS; size++) {
		const minRepeats = size === 1 ? 4 : 3;
		for (let start = 0; start + size * minRepeats <= words.length; start++) {
			let repeats = 1;
			while (start + (repeats + 1) * size <= keys.length) {
				const offset = start + repeats * size;
				let same = true;
				for (let k = 0; k < size && same; k++) {
					same = keys[start + k] !== "" && keys[start + k] === keys[offset + k];
				}
				if (!same) break;
				repeats++;
			}
			if (repeats >= minRepeats) {
				words.splice(start + size, (repeats - 1) * size);
				keys.splice(start + size, (repeats - 1) * size);
			}
		}
	}
	return words.join(" ");
}

/** Cleans model artifacts from a transcribed segment before it is shown as a caption. */
export function cleanTranscript(text: string): string {
	const trimmed = text.trim();
	// Cohere emits a bare lowercase "you" for near-silent chunks; real speech comes back punctuated.
	if (trimmed === "you") return "";
	return collapseRepeats(trimmed);
}
