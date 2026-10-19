---
section: Fixed
audience: user
---

- **A module created mid-session now clears the importer's missing-import (closes #4320)** — Language servers that cache a failed module lookup (Pyrefly) kept reporting `missing-import` and a definition at the import line after the module appeared, until the server restarted. pi-lens now announces a file created after the server started as Created, once, before any cached answer in the same call, whatever the path order; `rename_file` announces the moved-in path as Created too, and so do sibling packages served by the same server. pi-lens's own edits stay announced as edits, and only cached findings of a server that heard of a new file are re-checked.
