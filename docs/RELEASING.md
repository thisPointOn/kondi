# Releasing Kondi (cross-platform)

Kondi ships as a Tauri desktop app. CI builds native installers for macOS
(Apple-silicon + Intel), Windows, and Linux, and the write-containment guard
ships as a bundled `kondi-guard` sidecar so end users need **nothing installed**
for the core flow (API providers + containment). `claude`/`codex` CLIs and `git`
are optional power-user extras.

## How a release runs

`.github/workflows/release.yml` triggers on a `v*` tag (or manual dispatch). Each
runner:

1. builds the `kondi-guard` sidecar for its platform (`src-tauri/build-guard.sh`
   → `src-tauri/binaries/kondi-guard-<target-triple>`),
2. builds the frontend (`vite build` → `dist/`),
3. runs `tauri build` (via `tauri-apps/tauri-action`), bundling the sidecar via
   `bundle.externalBin`, and uploads the installers to a **draft** GitHub Release.

To cut a release:

```bash
# bump version in src-tauri/tauri.conf.json (and package.json), then:
git tag v0.2.0 && git push origin v0.2.0
```

Review the draft release the workflow creates, then publish it.

`.github/workflows/ci.yml` runs on every push/PR: `tsc --noEmit` (the type gate),
`vite build`, and a guard containment smoke test.

## Signing & notarization (required for distribution)

Unsigned apps are blocked by macOS Gatekeeper and warned by Windows SmartScreen.
The release workflow already wires the env vars — just add the repo secrets:

**macOS** (Apple Developer account):
- `APPLE_CERTIFICATE` (base64 of the .p12), `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY` (e.g. `Developer ID Application: …`)
- `APPLE_ID`, `APPLE_PASSWORD` (app-specific password), `APPLE_TEAM_ID`

**Windows** (Authenticode cert): set `bundle.windows.certificateThumbprint`
(and optionally `digestAlgorithm`, `timestampUrl`) in `tauri.conf.json`, with the
cert installed on the runner — or use an Azure Trusted Signing / signtool step.

## Auto-update (Tauri updater)

To enable in-app updates:
1. `npm run tauri signer generate` → produces a keypair.
2. Add the public key to `tauri.conf.json` under `plugins.updater.pubkey` and set
   the update `endpoints` (e.g. the GitHub Releases `latest.json`).
3. Add secrets `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
   (already referenced by the workflow) so update artifacts are signed.

## Notes / follow-ups

- **macOS universal binary**: the matrix builds arm64 and Intel separately. To
  ship a single universal `.dmg`, add `--target universal-apple-darwin` and have
  `build-guard.sh` produce a `lipo`-merged guard for that triple.
- **`npm run build`** (`tsc -b`) has pre-existing project-reference type errors and
  is NOT the build path; CI uses `tsc --noEmit` + `vite build`. Restoring a clean
  `tsc -b` is a good follow-up but not a release blocker.
