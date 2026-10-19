---
section: Added
audience: internal
---

- Every TLA+ config constant is now classified in `formal/switch-pins.json`, and each read-guard switch that mirrors a code choice names a test that drives the real code (#4393). `tests/config/tla-switch-pins.test.ts` fails when a constant is unclassified, a pin's test title is gone, or an `expect: pass` config disagrees with the pinned value, so a model can no longer keep proving a design the code dropped (#4387). Test-existence detectors now share `testDeclarations` (tests/support/sweep-kit.ts), so a skipped, conditional or uncalled test no longer counts as a pin.
