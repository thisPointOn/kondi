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

Unsigned apps still install (the v0.1.x draft builds are unsigned and fine for
testing), but macOS Gatekeeper blocks them for normal users and Windows
SmartScreen warns. The release workflow **already wires every signing env var** —
so "setup" is just: obtain the certs, then paste them as repo secrets
(Settings → Secrets and variables → Actions → New repository secret). No code
changes needed.

### macOS — step by step (needs an Apple Developer account, $99/yr)
1. Enroll at developer.apple.com → Account → Membership (note your **Team ID**).
2. Certificates → **+** → "Developer ID Application" → create, download the `.cer`,
   double-click to add to Keychain.
3. In Keychain Access, right-click the cert → **Export** → `.p12` (set a password).
4. Base64-encode it: `base64 -i cert.p12 | pbcopy`.
5. Create an **app-specific password** at appleid.apple.com → Sign-In & Security.
6. Add these repo **secrets** (the workflow already reads them):
   - `APPLE_CERTIFICATE` = the base64 string from step 4
   - `APPLE_CERTIFICATE_PASSWORD` = the `.p12` password from step 3
   - `APPLE_SIGNING_IDENTITY` = e.g. `Developer ID Application: Your Name (TEAMID)`
   - `APPLE_ID` = your Apple ID email
   - `APPLE_PASSWORD` = the app-specific password from step 5
   - `APPLE_TEAM_ID` = your Team ID from step 1

7. **Uncomment** the signing `env:` block in `.github/workflows/release.yml`
   (it ships commented out — a defined-but-empty `APPLE_CERTIFICATE` makes Tauri's
   bundler try to import an empty cert and fail the whole macOS build, so those
   vars must only be set once you actually have the secrets).

That's it — the next tagged build is signed **and notarized** automatically.

### Windows — step by step (needs a code-signing cert)
Cheapest modern path is **Azure Trusted Signing** (~$10/mo, no hardware token);
a traditional Authenticode cert from a CA (DigiCert/Sectigo) also works but newer
ones require a hardware/HSM token.
1. Get the cert (Azure Trusted Signing account, or a CA cert).
2. Either set `bundle.windows.certificateThumbprint` (+ `timestampUrl`) in
   `tauri.conf.json` with the cert on the runner, **or** add a signing step using
   Azure's `trusted-signing` GitHub Action before the bundle is uploaded.
3. (No extra secrets are pre-wired for Windows — add them per your chosen method.)

> Tip: ship **macOS + Linux signed first** (Linux needs no signing). Windows
> signing can come in a later release; an unsigned Windows build still runs, just
> with a SmartScreen "more info → run anyway" prompt.

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
