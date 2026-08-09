# Completion Plan @ares/datasource-files
> Generated: 2026-05-07
## Current Status (scan)
- package.json: description EMPTY
- test script: PLACEHOLDER/MISSING
- test files: MISSING
- docs: GENERIC/PLACEHOLDER
## Goal
Make the module ready for stable adoption: clear contract, documented configuration, minimal tests, and consistent packaging.
## Completion Steps
### High Priority
- Define the public surface: entrypoints, subpaths (if any), and exported symbols to treat as stable.
- Update the main document with a real description, use cases, and a quickstart aligned with the contract.
- Formalize configuration (keys read from `appSetup`, `config`, `policies`) and any legacy fallbacks.
- Introduce a smoke test (or replace the placeholder `test` script) to prevent regressions.
### Medium Priority
- Verify packaging: `main`, `type`, optional `exports`, and ESM/CJS import compatibility.
- Fix dependencies vs devDependencies and declare peerDependencies when needed.
### Low Priority
- Improve examples and add compatibility/security notes where useful.
- Add cross-references to related modules (core/web/files, etc.).
### Module notes (datasource)
- Document the driver/connection contract (pool/session/transactions) in relation to `@ares/core/datasources`.
- Add an end-to-end example with `aReS.loadDatasource(...)` + `mapper.execute(...)`.

## References
- Main doc EN: ./datasource-files.md
- Main doc IT: ../it/datasource-files.md
- Ticket: ../tickets/20260506-1052.md