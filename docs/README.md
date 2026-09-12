# Maintainer documentation

The root [README](../README.md) documents the extension for users. This
directory documents how the current system is designed, developed, tested, and
released.

- [Architecture](architecture.md) — runtime components and data flow
- [Design principles](design-principles.md) — strategy, rationale, and guardrails
- [Development](development.md) — local setup and common commands
- [Testing](testing.md) — unit, integration, and CI coverage
- [Build and release](build-and-release.md) — bundling, packaging, and releases
- [Dependencies](dependencies.md) — dependency roles and update constraints
- [Maintenance](maintenance.md) — compatibility and lifecycle conventions

These documents describe the complete current system, not only differences
from the upstream project. Keep them focused on decisions and workflows that
are not evident from a single source file. Commands, versions, and supported
platforms must remain consistent with `package.json` and `.github/workflows/`.
