# Release checklist

A v1 GA release of Ripple needs more than "it compiles."  This document is the
gate — every box must be checked before the app ships.  Work through it in order;
each section depends on the ones above it.

---

## 0. Pre-release (before the first beta tag)

| # | Item | Owner | Done |
|---|------|-------|------|
| 0.1 | All CI jobs green on `main` (protocol, Android unit + debug build, iOS unit tests). | CI | ✅ |
| 0.2 | `protocol/test-vectors.json` matches `node tools/protocol/gen-vectors.js` output and both app copies match. | CI | ✅ |
| 0.3 | `docs/FIELD_TESTING.md` Tier 1 scenarios (1.1–1.9) passed on at least **3 Android phones** (different manufacturers — must include one Xiaomi/Oppo/Realme) and **2 iPhones**. | Field team | ✅ |
| 0.4 | `docs/FIELD_TESTING.md` Tier 2 scenarios (2.1–2.5) passed on at least **2 Android + 1 iPhone** in a 3-phone line topology. | Field team | ✅ |
| 0.5 | Tier 3 scenario 3.5 (overnight link) ran for ≥ 8 h on at least one Android/iPhone pair; battery drain ≤ 5 % over 8 h (phones plugged in is fine, drain must be reported). | Field team | ✅ |
| 0.6 | No open **P0/P1** bugs labelled `field-test` or `bug`. | Maintainer | ✅ |
| 0.7 | `PROTOCOL.md` reviewed for correctness by at least one person who did *not* write it. | Reviewer | ✅ |
| 0.8 | Security: keys, nonce, node-ID derivation, ECIES AAD re-verified against spec. | Reviewer | ✅ |
| 0.9 | Android `INTERNET` permission absent from merged manifest. | CI / manual | ✅ |
| 0.10 | iOS `NSBluetoothAlwaysUsageDescription` string is clear and honest. | Manual | ✅ |

---

## 1. Beta release (tag `v1.0.0-beta.1`)

### 1.1 Cut the tag

```bash
git tag -a v1.0.0-beta.1 -m "Ripple v1.0.0 beta 1"
git push origin v1.0.0-beta.1
```

The single **`release.yml`** workflow runs for every `v*` tag. Build jobs are
read-only; its `publish` job alone receives release-write permission and creates
or updates the tag's Release. The tag remains pushed if validation fails, but no
release is published.

| Step | What it produces |
|------|-----------------|
| Protocol + release-payload tests | Must pass before platform builds; vectors are regenerated and compared with both app copies, and release-note/assets dry-run cases are tested. |
| Android debug build | Debug-signed APK and checksum workflow artifact. On prerelease tags, the publisher attaches it as a field-test-only asset; on stable tags, it stays in the workflow artifacts. |
| Android stable bundle | For tags without a hyphen, a store-upload-ready AAB signed with the configured Play upload key, or an explicitly unsigned AAB marked not store-ready. Stable releases stay drafts. |
| iOS | Unsigned `Ripple.xcarchive` workflow artifact. It is not an `.ipa`, is not directly installable, and is not attached to a release. |
| Publisher | The one `publish` job validates checksums, prepares notes/assets, prunes stale attachments, then verifies the final release notes and asset list. |

### 1.2 Distribute the beta

| Platform | Channel | Notes |
|----------|---------|-------|
| Android | GitHub prerelease APK + checksum | Debug-signed field-test build; testers sideload and enable "Install unknown apps." Do not use it as a Play Store build. |
| iOS | Signed/exported archive to TestFlight or Ad Hoc | The CI `.xcarchive` is unsigned and only a workflow artifact; sign/export it using `docs/RELEASING.md`. Ad Hoc requires UDID registration. |

Announce the beta:
- Post in Discussions (or a pinned issue) with the download link, the field-test
  checklist link, and a link to the **Beta feedback** issue template.
- Tag the call for testers in the README "Status" section.

### 1.3 Beta exit criteria

All of these must hold before moving to RC:

| # | Criterion | Evidence |
|---|-----------|----------|
| 1.1 | Tier 1 scenarios pass on **≥ 5 distinct phone models** (≥ 2 iPhone, ≥ 3 Android) with field-test reports filed. | ✅ Field reports filed. |
| 1.2 | Tier 2 scenarios pass on **≥ 2 distinct 3-phone topologies** (at least one Android-only, one mixed). | ✅ Field reports filed. |
| 1.3 | No open **P0** bugs. | ✅ Issue tracker clear. |
| 1.4 | All open **P1** bugs have a documented workaround or are explicitly deferred with maintainer sign-off. | ✅ All deferred P1s signed off. |
| 1.5 | Overnight (Tier 3.5) test passed on ≥ 2 device pairs with battery drain ≤ 5 % / 8 h. | ✅ Field reports filed. |
| 1.6 | At least one test with **4+ phones** in the same mesh (Tier 3.3). | ✅ Field report filed. |
| 1.7 | Stress test (Tier 3.4 — 20 rapid broadcasts) passed on at least one topology. | ✅ Field report filed. |
| 1.8 | Diagnostics export reviewed — no message plaintext in the event log. | ✅ Manual audit passed. |

---

## 2. Release Candidate (tag `v1.0.0-rc.1`)

Same workflow as beta; the tag triggers it.

| # | Item | Done |
|---|------|------|
| 2.1 | All beta exit criteria met. | ✅ |
| 2.2 | Changelog drafted (`CHANGELOG.md` or GitHub Release notes). | ✅ |
| 2.3 | App store metadata prepared (descriptions, screenshots, privacy policy URL). | ✅ |
| 2.4 | Google Play internal testing track upload (if Play Store publishing is configured). | ⏭️ Not configured. |
| 2.5 | TestFlight external beta (if configured). | ⏭️ Not configured. |
| 2.6 | At least 48 h soak with no new P0/P1 filed. | ✅ Soaked 2026-09-05 → 2026-09-07, no regressions. |

---

## 3. GA release (tag `v1.0.0`)

| # | Item | Done |
|---|------|------|
| 3.1 | RC soak complete, no regressions. | ✅ |
| 3.2 | README "Status" section updated to "Released v1.0.0." | ✅ |
| 3.3 | Git tag `v1.0.0` pushed; the sole `release.yml` publisher attaches the Android AAB and checksum to a draft, while debug APK and unsigned iOS archive remain labeled workflow artifacts. | ✅ |
| 3.4 | Maintainer reviews the stable draft, verifies the AAB/checksum and iOS signing/export separately, then publishes the release notes on GitHub. | ✅ |
| 3.5 | (Optional) Play Store / App Store submissions. | ⏭️ Future. |
| 3.6 | Announce: social media, project README, Discussions. | ✅ |
| 3.7 | Lock the release branch (or mark it `protected`); open `main` for v2 work. | ✅ |

---

## Severity levels

Used throughout this document:

| Level | Definition |
|-------|-----------|
| **P0** | Data loss, crash on launch, security flaw, message delivered to wrong recipient. |
| **P1** | Feature broken in common scenario (e.g. store-and-forward never delivers, ACK never arrives, background notifications broken on ≥ 1 popular phone). |
| **P2** | Feature broken in edge case, cosmetic issue, minor battery concern. |
| **P3** | Nice-to-have, docs typo, accessibility improvement. |

---

*This checklist is a living document. If you find a gap, open a PR.*
