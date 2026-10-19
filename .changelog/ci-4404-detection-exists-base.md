---
section: Changed
audience: internal
---

- The PR-body check accepts `Gap: exists: <path>` only when the path is a file on the PR's base commit (#4404). A test the PR itself adds is not an existing layer; the check refuses it and points at an issue ref or `none: <reason>`. When the base cannot be resolved, the check fails closed with a fetch hint. The class-sweep composition test also stops scanning the whole test tree (#4385).
