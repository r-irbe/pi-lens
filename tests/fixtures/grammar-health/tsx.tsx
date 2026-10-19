import { useState, type ReactNode } from "react";

interface ButtonProps {
	label: string;
	onPress?: (count: number) => void;
	children?: ReactNode;
}

export function Counter<T extends number>({ label, onPress }: ButtonProps) {
	const [count, setCount] = useState<T | 0>(0);
	return (
		<section className="counter" data-count={count}>
			<button
				type="button"
				onClick={() => {
					setCount((c) => (c as number) + 1);
					onPress?.(count as number);
				}}
			>
				{label}: {count}
			</button>
			{count > 2 ? <>many</> : null}
		</section>
	);
}
