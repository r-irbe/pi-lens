// #3961: force the analyze bin's stdin read to fail BEFORE any payload is
// parsed, so the test can prove the `--cwd` argv value is retained through the
// failure path instead of being replaced by `process.cwd()`.
//
// This fakes the stream boundary only (the async iterator the bin's
// `readStdin()` consumes); the real bin, analyzer, and failure sinks run.
process.stdin[Symbol.asyncIterator] = () => {
	throw new Error("stdin probe boom");
};
