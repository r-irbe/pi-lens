import { registerHooks, syncBuiltinESMExports } from "node:module";

const params = new URL(import.meta.url).searchParams;
const message = params.get("message") ?? "Cannot find package '@earendil-works/pi-tui'";

if (params.get("target") === "ipc") {
	const { default: netModule } = await import("node:net");
	netModule.createConnection = () => {
		throw new Error(message);
	};
	syncBuiltinESMExports();
} else {
	registerHooks({
		resolve(specifier, context, nextResolve) {
			if (specifier === "@earendil-works/pi-tui") {
				if (params.has("nonError")) throw message;
				throw Object.assign(new Error(message), { code: "ERR_MODULE_NOT_FOUND" });
			}
			return nextResolve(specifier, context);
		},
	});
}
