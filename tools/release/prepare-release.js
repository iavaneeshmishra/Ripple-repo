'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function fail(message) {
  throw new Error(message);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function requireRegularFile(directory, name) {
  const file = path.join(directory, name);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    fail(`Required release input is missing: ${name}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    fail(`Release input must be a non-empty regular file: ${name}`);
  }
  return file;
}

function verifyChecksum(sourceDir, artifactName) {
  const checksumFile = requireRegularFile(sourceDir, 'SHA256SUMS');
  const lines = fs.readFileSync(checksumFile, 'utf8').trim().split(/\r?\n/);
  if (lines.length !== 1) fail('SHA256SUMS must contain exactly one artifact entry.');
  const match = /^([a-f0-9]{64})  (.+)$/.exec(lines[0]);
  if (!match || match[2] !== artifactName) {
    fail(`SHA256SUMS must contain a sha256sum entry for ${artifactName}.`);
  }
  const actual = sha256(requireRegularFile(sourceDir, artifactName));
  if (match[1] !== actual) fail(`SHA-256 mismatch for ${artifactName}.`);
  return actual;
}

function validateOptions(options) {
  const {
    tag, channel, signing, repo, commit, runId, serverUrl,
    sourceDir, assetsDir, notesFile,
  } = options;
  if (typeof tag !== 'string' || !/^v[0-9A-Za-z][0-9A-Za-z.+/_-]*$/.test(tag)) {
    fail('Tag must be a v-prefixed release tag containing only safe SemVer/tag characters.');
  }
  const inferredChannel = tag.includes('-') ? 'prerelease' : 'stable';
  if (channel !== inferredChannel) {
    fail(`Tag ${tag} is a ${inferredChannel} tag, not ${channel}.`);
  }
  if (channel === 'stable' && !['store-ready', 'unsigned'].includes(signing)) {
    fail('Stable releases require signing status "store-ready" or "unsigned".');
  }
  if (channel === 'prerelease' && signing !== 'none') {
    fail('Pre-release payloads must use signing status "none" (debug APK only).');
  }
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    fail('Repository must be in owner/name form.');
  }
  if (typeof commit !== 'string' || !/^[a-f0-9]{7,64}$/i.test(commit)) {
    fail('Commit must be a hexadecimal Git SHA.');
  }
  if (typeof runId !== 'string' || !/^\d+$/.test(runId)) {
    fail('Workflow run ID must be numeric.');
  }
  let url;
  try {
    url = new URL(serverUrl);
  } catch {
    fail('GitHub server URL must be an absolute URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) fail('GitHub server URL must use HTTP or HTTPS.');
  for (const [label, value] of [['source directory', sourceDir], ['assets directory', assetsDir], ['notes file', notesFile]]) {
    if (typeof value !== 'string' || value.length === 0) fail(`Missing ${label}.`);
  }
  const source = path.resolve(sourceDir);
  const assets = path.resolve(assetsDir);
  const notes = path.resolve(notesFile);
  if (assets === source || assets.startsWith(`${source}${path.sep}`)) {
    fail('Assets directory must not be the source directory or a child of it.');
  }
  if (notes === assets || notes.startsWith(`${assets}${path.sep}`)) {
    fail('Release notes must be written outside the public assets directory.');
  }
}

function makeNotes({ tag, channel, signing, repo, commit, runId, serverUrl, artifactName }) {
  const baseUrl = `${serverUrl.replace(/\/$/, '')}/${repo}`;
  const runUrl = `${baseUrl}/actions/runs/${runId}`;
  const tagPath = encodeURIComponent(tag);
  const runbook = `${baseUrl}/blob/${tagPath}/docs/RELEASING.md`;

  if (channel === 'prerelease') {
    return [
      `# Ripple ${tag}`,
      '',
      `Pre-release for field testing, built from commit \`${commit}\`. This is not a store release.`,
      '',
      `[Tagged build workflow run](${runUrl})`,
      '',
      '## Android',
      `- \`${artifactName}\` is a debug-signed APK for field testing and sideloading only. It is **not store-ready** and is not suitable for upgrading a Play-signed installation.`,
      '- `SHA256SUMS` verifies the APK. `ARTIFACT-NOTICE.txt` explains its status.',
      '',
      '## iOS',
      '- This is an Android-only pre-release. An unsigned iOS archive may be uploaded separately as a workflow artifact if its independent build job succeeds; it is not attached to this release or distribution-ready.',
      '',
      '## Field testing',
      `Use the [field-test checklist](${baseUrl}/blob/${tagPath}/docs/FIELD_TESTING.md). See the [release runbook](${runbook}) for signing and distribution guidance.`,
      '',
    ].join('\n');
  }

  const storeStatus = signing === 'store-ready'
    ? `- \`${artifactName}\` is signed with the configured Ripple Google Play upload key and is intended for Play Console upload. Verify the checksum, tag, version, and signing certificate before submission; Google Play generates installable APKs after processing the bundle.`
    : `- \`${artifactName}\` is **unsigned and not store-ready**. Do not upload it to Google Play; configure the Android upload-key secrets and rebuild for a store-upload-ready AAB.`;

  return [
    `# Ripple ${tag}`,
    '',
    `Stable Android release bundle built from commit \`${commit}\`.`,
    '',
    `[Tagged build workflow run](${runUrl})`,
    '',
    '## Android',
    storeStatus,
    '- `SHA256SUMS` verifies the AAB; `SIGNING-NOTICE.txt` states whether it is store-upload-ready or unsigned.',
    `- The debug APK is retained only as a workflow artifact in the [build run](${runUrl}); it is for field testing, not store distribution.`,
    '',
    '## iOS',
    '- This is an Android-only release. An unsigned iOS archive may be uploaded separately as a workflow artifact if its independent build job succeeds; it is not part of this Release and is not distribution-ready.',
    '',
    `See the [release runbook](${runbook}) for store upload and signing steps.`,
    '',
  ].join('\n');
}

function prepareRelease(options) {
  validateOptions(options);
  const {
    tag, channel, signing, repo, commit, runId, serverUrl,
    sourceDir, assetsDir, notesFile,
  } = options;
  const source = path.resolve(sourceDir);
  const assets = path.resolve(assetsDir);
  const safeTag = tag.replaceAll('/', '-');
  const artifactName = channel === 'prerelease'
    ? `ripple-${safeTag}-debug.apk`
    : `ripple-${safeTag}-${signing}.aab`;
  const noticeName = channel === 'prerelease' ? 'ARTIFACT-NOTICE.txt' : 'SIGNING-NOTICE.txt';
  const notice = requireRegularFile(source, noticeName);
  const artifact = requireRegularFile(source, artifactName);
  const runbook = requireRegularFile(source, 'RELEASING.md');
  const artifactSha256 = verifyChecksum(source, artifactName);
  const noticeText = fs.readFileSync(notice, 'utf8');

  if (channel === 'prerelease' && !/DEBUG-SIGNED APK[\s\S]*not store-ready/i.test(noticeText)) {
    fail('Debug APK notice must clearly say the APK is for testing and not store-ready.');
  }
  if (signing === 'store-ready' && !/STORE-UPLOAD-READY AAB/i.test(noticeText)) {
    fail('Signed AAB notice must identify it as store-upload-ready.');
  }
  if (signing === 'unsigned' && !/UNSIGNED AAB[\s\S]*not store-ready/i.test(noticeText)) {
    fail('Unsigned AAB notice must clearly say the bundle is not store-ready.');
  }

  const allowedInputs = new Set([artifactName, 'SHA256SUMS', noticeName, 'RELEASING.md']);
  if (channel === 'stable') allowedInputs.add('mapping.txt');
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!allowedInputs.has(entry.name) || !entry.isFile()) {
      fail(`Unexpected file in release build artifact: ${entry.name}`);
    }
  }

  fs.rmSync(assets, { recursive: true, force: true });
  fs.mkdirSync(assets, { recursive: true });
  for (const name of [artifactName, 'SHA256SUMS', noticeName, 'RELEASING.md']) {
    fs.copyFileSync(path.join(source, name), path.join(assets, name));
  }

  const notes = makeNotes({ ...options, artifactName });
  const resolvedNotes = path.resolve(notesFile);
  fs.mkdirSync(path.dirname(resolvedNotes), { recursive: true });
  fs.writeFileSync(resolvedNotes, notes);

  const assetNames = fs.readdirSync(assets).sort();
  if (assetNames.length !== 4) fail(`Expected four public release assets, found ${assetNames.length}.`);
  const manifest = {
    tag,
    channel,
    commit,
    workflowRun: `${serverUrl.replace(/\/$/, '')}/${repo}/actions/runs/${runId}`,
    assets: assetNames.map((name) => ({
      name,
      sha256: sha256(path.join(assets, name)),
      bytes: fs.statSync(path.join(assets, name)).size,
    })),
    releaseNotes: {
      file: path.basename(resolvedNotes),
      sha256: sha256(resolvedNotes),
      bytes: fs.statSync(resolvedNotes).size,
    },
  };
  return manifest;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--') || i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
      fail(`Expected --option value; got ${key}.`);
    }
    options[key.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = argv[i + 1];
    i += 1;
  }
  const required = [
    'tag', 'channel', 'signing', 'repo', 'commit', 'runId', 'serverUrl',
    'sourceDir', 'assetsDir', 'notesFile',
  ];
  for (const key of required) if (!options[key]) fail(`Missing required option --${key}.`);
  return options;
}

if (require.main === module) {
  try {
    const manifest = prepareRelease(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    console.error(`Release preparation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { prepareRelease };
