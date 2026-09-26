import { expect, test } from "bun:test";
import { cleanTranscript } from "./transcript-cleanup";

test("collapses a looping multi-word phrase to one occurrence", () => {
	expect(
		cleanTranscript(
			"it was fast it looks like it looks like it looks like it looks like it",
		),
	).toBe("it was fast it looks like it");
});

test("ignores case and punctuation when matching repeats", () => {
	expect(cleanTranscript("Thank you. Thank you, thank you!")).toBe(
		"Thank you.",
	);
});

test("keeps natural short repetitions", () => {
	expect(cleanTranscript("no no no, don't do that")).toBe(
		"no no no, don't do that",
	);
	expect(cleanTranscript("go go go go go")).toBe("go");
	expect(cleanTranscript("we need to go, we need to hurry")).toBe(
		"we need to go, we need to hurry",
	);
});

test("drops the bare silence artifact but keeps spoken 'you'", () => {
	expect(cleanTranscript(" you ")).toBe("");
	expect(cleanTranscript("You.")).toBe("You.");
	expect(cleanTranscript("you know what I mean")).toBe("you know what I mean");
});
