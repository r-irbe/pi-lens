import { readFileSync } from "node:fs";

export interface Shape {
	area(): number;
}

type Mode = "fast" | "safe";

export class Rect implements Shape {
	constructor(
		private readonly w: number,
		private readonly h: number,
	) {}

	area(): number {
		return this.w * this.h;
	}
}

export function total<T extends Shape>(shapes: readonly T[], mode: Mode = "safe"): number {
	let sum = 0;
	for (const shape of shapes) {
		sum += shape.area();
	}
	return mode === "fast" ? sum : Math.round(sum);
}

enum Level {
	Low = 1,
	High,
}

const text = readFileSync("input.txt", "utf8") as string;
export const parsed = JSON.parse(text) as Record<string, Level>;
