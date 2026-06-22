# Licensing

Kondi is split-licensed by component:

| Component | Path | License |
|-----------|------|---------|
| **Backend** (Rust / Tauri) | `mcp-connect-mvp/src-tauri/` | **MIT** — see [`mcp-connect-mvp/src-tauri/LICENSE`](mcp-connect-mvp/src-tauri/LICENSE) |
| **Frontend** (React / TypeScript) and everything else | the rest of the repo | **AGPL-3.0-only** — see [`LICENSE`](LICENSE) |

## What this means

- The **Rust/Tauri backend** (`src-tauri/`, including the `kondi-guard` crate) is
  released under the permissive **MIT** license. You may reuse it in your own
  projects, including proprietary ones, under the MIT terms.
- The **frontend** and the project as a whole remain under **AGPL-3.0-only**. MIT
  is compatible with the AGPL, so the MIT-licensed backend can be combined with
  the AGPL frontend; when you **convey or network-deploy the combined Kondi
  application**, the AGPL-3.0 obligations (including source availability for
  network users) apply to the combined work.

In short: take the backend under MIT if you want it standalone; the shipped Kondi
app is AGPL-3.0.

If a file carries its own license header, that header governs that file.
