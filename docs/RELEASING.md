# Releasing Ripple

This runbook is the source of truth for tagged Android releases. The single
`.github/workflows/release.yml` workflow builds Android artifacts and also
attempts an unsigned iOS archive as an independent workflow artifact. The iOS
archive is not included in an Android release, is not signed or submitted, and
its job does not gate Android publishing. The sole `publish` job creates or
updates the tag's Android GitHub Release; Android build jobs only upload
workflow artifacts and have read-only permissions.

Prerelease Releases contain a clearly labeled Android debug APK for field
testing. A stable Android release remains a draft until reviewed and contains
either a Play upload-ready, upload-key-signed AAB or an explicitly unsigned,
non-store-ready AAB. The unsigned iOS archive is not an IPA or a GitHub Release
asset. Google Play submission and iOS signing/export remain manual.

Before using the workflow, protect the `v*` tag namespace with a repository
ruleset that restricts tag creation and updates to release maintainers. Do not
dispatch a release build from an unreviewed branch.

## 1. Prepare one release commit

For an Android-only release, prerequisites are Node 22+, JDK 17, and Google
Play Console access. The separate unsigned iOS archive job uses macOS/Xcode but
needs no signing certificate; Apple signing and certification are only needed
for a future iOS distribution.

1. Start from a clean, reviewed `master` commit. Pick a SemVer tag such as
   `v1.0.1`.
2. Set Android's monotonically increasing `versionCode` and user-visible
   `versionName` in `android/app/build.gradle.kts`. For this release they are
   `2` and `1.0.1`. Do not bump the iOS `Info.plist` version or build number;
   this release does not distribute an iOS app.
3. Run the release checks and prove all shared protocol vectors are unchanged:

   ```bash
   node tools/protocol/test.js                 # all protocol regression tests must pass
   node tools/release/test.js                   # dry-run stable/prerelease assets and notes
   node tools/protocol/gen-vectors.js
   git diff --exit-code protocol/test-vectors.json \
     android/app/src/test/resources/test-vectors.json \
     ios/RippleTests/Resources/test-vectors.json
   ```

4. Merge the version PR only after the required CI checks are green. On the
   resulting `master`, record the exact commit and tag it:

   ```bash
   git pull --ff-only origin master
   git status --short                         # must print nothing
   git tag -a v1.0.1 -m "Ripple v1.0.1"
   git push origin v1.0.1
   ```

For every `v*` tag, `.github/workflows/release.yml` runs protocol conformance
and release-payload dry-run tests, then builds the Android debug APK. Stable tags
(no hyphen) also build an Android release AAB. The unsigned iOS archive is built
in a separate job and may be uploaded as a workflow artifact, but it is neither
included in the Android release nor a dependency of the publisher. The only job
with `contents: write` is `publish`; it waits for protocol and Android builds,
validates checksums, constructs the Android release notes and exact public asset
set, then creates or updates the GitHub Release, prunes stale attachments, and
verifies the final release notes and exact remote asset list.

- **Prerelease tag** (for example, `v1.0.1-rc.1`): publish the debug APK,
  `SHA256SUMS`, `ARTIFACT-NOTICE.txt`, and `RELEASING.md` as a prerelease. The
  APK is for testing only, not store-ready. An unsigned iOS archive may be
  uploaded independently as a workflow artifact if its build succeeds; it is
  not an `.ipa` or a release asset.
- **Stable tag** (for example, `v1.0.1`): create or update a **draft** release
  with one AAB, its `SHA256SUMS`, `SIGNING-NOTICE.txt`, and `RELEASING.md`. With
  all four Android signing secrets configured, the asset is named
  `ripple-<tag>-store-ready.aab` and is signed with the Play upload key. With no
  secrets, it is `ripple-<tag>-unsigned.aab` and the notice and release notes
  explicitly say not to upload it to Play. A partial signing configuration
  fails the build. The debug APK, an iOS archive if its independent job succeeds,
  and the R8 mapping file remain workflow artifacts; the iOS archive and mapping
  file are never attached to the public release.

A rerun may replace assets only on a draft stable release; the workflow refuses
to alter an already-published stable release. A prerelease tag creates a
prerelease, or updates an existing draft/prerelease. A manual dispatch is
restricted to `master`, builds workflow artifacts, and never creates or updates
a GitHub Release. Keep all build artifacts, store records, and notes tied to the
same tag and commit SHA. Run `node tools/release/test.js` to exercise the signed,
unsigned, and prerelease payload/notes paths with temporary fixtures; it does
not call GitHub or modify a release.

## 2. Android signing

### Create and protect the upload key (once)

Google Play App Signing should hold the app-signing key; the key below is the
separate upload key. Generate it offline and back it up in the project's secret
store. Never commit a keystore, password, or encoded keystore.

```bash
keytool -genkeypair -v \
  -keystore ripple-upload.jks \
  -alias ripple-upload \
  -keyalg RSA -keysize 4096 -validity 10000
keytool -list -v -keystore ripple-upload.jks -alias ripple-upload
```

The release workflow recognizes exactly these GitHub Actions repository
secrets:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | Base64 of the binary JKS/PKCS12 file |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | `ripple-upload` (or the alias chosen above) |
| `ANDROID_KEY_PASSWORD` | Private-key password |

With GitHub CLI authenticated for this repository, set them without putting
passwords in a command line or tracked file:

```bash
base64 < ripple-upload.jks | tr -d '\n' | gh secret set ANDROID_KEYSTORE_BASE64
printf %s ripple-upload | gh secret set ANDROID_KEY_ALIAS
gh secret set ANDROID_KEYSTORE_PASSWORD     # paste at the prompt
gh secret set ANDROID_KEY_PASSWORD          # paste at the prompt
```

All four present means CI signs the AAB. None present means CI intentionally
produces an **unsigned** AAB plus `SIGNING-NOTICE.txt` and this runbook. On a
stable tag, these files are attached to the draft release; manual runs save them
only as a workflow artifact. A partial configuration fails rather than silently
producing the wrong artifact. Do not upload an artifact whose filename or notice
says `unsigned`; configure all secrets and rerun the tag workflow instead.

To make the same signed bundle locally, use environment variables so secrets do
not enter Gradle files:

```bash
cd android
export RIPPLE_KEYSTORE_PATH=/absolute/path/ripple-upload.jks
read -rsp 'Keystore password: ' RIPPLE_KEYSTORE_PASSWORD; export RIPPLE_KEYSTORE_PASSWORD; echo
export RIPPLE_KEY_ALIAS=ripple-upload
read -rsp 'Key password: ' RIPPLE_KEY_PASSWORD; export RIPPLE_KEY_PASSWORD; echo
./gradlew clean bundleRelease --no-daemon
jarsigner -verify app/build/outputs/bundle/release/app-release.aab
unset RIPPLE_KEYSTORE_PASSWORD RIPPLE_KEY_PASSWORD
```

### CI artifact and no-internet check

For stable-tag builds and manual runs on `master`, the Android job uses the
checked-in Gradle 8.9 wrapper and JDK 17, runs `bundleRelease`, and fails if any
merged release manifest declares `android.permission.INTERNET`. When signing is
configured, it verifies the AAB signature and labels the bundle
`store-ready`; with no signing secrets, it clearly labels the artifact
`unsigned` and not store-ready. For tags, the sole `publish` job attaches the
AAB, `SHA256SUMS`, signing notice, and runbook to a stable draft; manual runs
only produce workflow artifacts.

The Android debug APK is always a separate debug-signed workflow artifact and
is only attached to prereleases for field testing. The unsigned iOS archive is
also a workflow artifact, never an IPA or GitHub Release asset. The R8
`mapping.txt` file is retained only in the Android bundle workflow artifact; it
is not attached to the public release. For Play, download it from the same
workflow run and upload it to Play Console alongside the AAB.

Before store upload, inspect the workflow run and certificate. The source
manifest's explicit no-internet invariant can also be checked quickly with:

```bash
! grep -R 'android.permission.INTERNET' android/app/src/main/AndroidManifest.xml
```

The workflow checks the merged manifest as the authoritative result, so a
future dependency cannot smuggle the permission in unnoticed.

### Play internal track

1. In Play Console, create/select package `app.ripple.mesh`, enroll in Play App
   Signing, and register the upload certificate from the key above.
2. Complete App content, privacy/data-safety, Bluetooth/nearby-device, optional
   location, encryption, and emergency-feature declarations truthfully. Ripple
   has no server transport; SOS location is attached only after the user's
   opt-in. Store forms and a privacy policy still need maintainer review.
3. Open **Testing → Internal testing**, create a release, and upload the
   signed `.aab` from the stable tag's draft release or workflow artifact.
   Upload `mapping.txt` from that workflow run for de-obfuscation.
4. Confirm Play reports the expected version name/code and upload certificate.
   Add internal testers, review warnings, roll out, and install from the Play
   link on at least two physical BLE-capable phones.
5. Run the Tier 1 field checklist and identity backup/restore acceptance before
   promoting beyond internal testing. Every later Play upload must increment
   `versionCode`.

### F-Droid submission

English store metadata is in `fastlane/metadata/android/en-US/` (`title.txt`,
`short_description.txt`, `full_description.txt`, and version-code changelogs).
Keep it synchronized with README claims. Submit/update the F-Droid build recipe
against the immutable release tag and package `app.ripple.mesh`; F-Droid should
build from source, not consume the Play-signed AAB.

During review, point to the manifest and the release workflow's merged-manifest
check as evidence that the app requests no `INTERNET` permission. Re-check that
new dependencies are reproducibly obtainable by F-Droid and that no proprietary
service SDK has entered the app.

## 3. iOS archive, export, and TestFlight

The tag workflow uploads `Ripple.xcarchive` as the `ripple-ios-archive` workflow
artifact. CI builds it with code signing disabled; it is not an `.ipa`, cannot be
installed directly, and is not attached to the GitHub Release. Use a signing
team and the export procedure below to produce an App Store/TestFlight IPA.

### Signing setup

1. Use an Apple Developer team that can publish `app.ripple.mesh`. Create the
   matching App Store Connect app record and accept current agreements.
2. In Xcode, sign in with that account. Automatic signing may create the Apple
   Distribution certificate and App Store provisioning profile; the team must
   have permission to do so.
3. From the tagged checkout, generate the project and run tests:

   ```bash
   cd ios
   xcodegen generate
   xcodebuild test -scheme Ripple -project Ripple.xcodeproj \
     -destination 'platform=iOS Simulator,name=iPhone 16' \
     CODE_SIGNING_ALLOWED=NO DEVELOPMENT_TEAM=''
   ```

The generated project is disposable; `ios/project.yml` is the tracked source of
truth. Its shared `Ripple` scheme explicitly archives the Release configuration.

### Archive and export

Replace `TEAMID` and keep the archive with the tag's release records:

```bash
cd ios
rm -rf build/Ripple.xcarchive build/export
xcodegen generate
xcodebuild archive \
  -scheme Ripple \
  -project Ripple.xcodeproj \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$PWD/build/Ripple.xcarchive" \
  DEVELOPMENT_TEAM=TEAMID \
  -allowProvisioningUpdates

xcodebuild -exportArchive \
  -archivePath "$PWD/build/Ripple.xcarchive" \
  -exportPath "$PWD/build/export" \
  -exportOptionsPlist ExportOptions-AppStore.plist \
  -allowProvisioningUpdates
```

Validate the archive in Xcode Organizer, then upload the exported IPA with
Apple's Transporter app (or choose **Distribute App → App Store Connect** in
Organizer). In App Store Connect, wait for processing, answer export-compliance
questions as below, add the build to an internal TestFlight group, and install it
on at least two physical iPhones. Bluetooth mesh behavior cannot be accepted in
the simulator.

### Encryption export compliance decision

`ITSAppUsesNonExemptEncryption` is deliberately set to **`true`** in
`Info.plist`. This is the conservative declaration: Ripple encrypts direct
messages and identity backups using standard ECDH/HKDF/AES-GCM and signs with
ECDSA. Using Apple's CryptoKit/CommonCrypto implementations does not by itself
make encrypted messaging exempt, and “no internet” does not remove export
obligations.

For every App Store Connect submission:

1. declare that the app uses encryption and describe the standard, publicly
   documented algorithms above;
2. determine with the organization's export-compliance owner whether the build
   qualifies for mass-market treatment and whether an ENC self-classification
   report, CCATS, or other documentation is required for the maintainer's
   country and distribution; upload the requested document/reference;
3. retain the App Store Connect answers and any annual U.S. self-classification
   filing with the release records.

Do not flip the plist value to `false` merely to bypass the questionnaire. If
qualified counsel or written Apple/BIS guidance supports a different answer,
document that decision in a reviewed PR before changing it. This runbook records
the project's technical decision, not legal advice.

## 4. Final release record

Before publishing the stable GitHub draft, review the tag and commit, AAB signing
notice and certificate fingerprint, release notes, and `SHA256SUMS`; confirm the
iOS archive has been signed/exported and tested separately. The workflow leaves
the stable release as a draft so a maintainer can make this review first.

For both stores, record:

- tag and full commit SHA;
- workflow run URL and Android signing certificate fingerprint;
- Android version code/name and iOS build/short version;
- Play internal release and TestFlight build links;
- export-compliance answer/document reference;
- physical-device acceptance issues and any known limitations.

Diagnostics exports now include a privacy-bounded previous-crash record: Android
replays a truncated stack with no exception message, while iOS includes the
truncated exception name/reason after the next launch. Neither handler reads or
stores message records, keys, or full node IDs.
