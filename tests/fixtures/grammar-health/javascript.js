import { readFile } from "node:fs/promises";

class Counter {
	#count = 0;

	increment(by = 1) {
		this.#count += by;
		return this;
	}

	get value() {
		return this.#count;
	}
}

const pick = ({ a, b = 2, ...rest }) => ({ a, b, extra: Object.keys(rest) });

export async function load(path) {
	try {
		const text = await readFile(path, "utf8");
		return JSON.parse(text)?.items ?? [];
	} catch (error) {
		console.error(`failed: ${error.message}`);
		return [];
	}
}

const counter = new Counter().increment().increment(2);
for (const [key, value] of Object.entries(pick({ a: counter.value }))) {
	console.log(key, value);
}
