'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareRelease } = require('./prepare-release');

const COMMIT = 'a'.repeat(40);
const BASE = {
  repo: 'iavaneeshmishra/Ripple-repo',
  commit: COMMIT,
  runId: '123456789',
  serverUrl: 'https://github.com',
};

function writeSourceFile(directory, name, content) {
  fs.writeFileSync(path.join(directory, name), content);
}

function makeArtifact(directory, name, bytes) {
  writeSourceFile(directory, name, bytes);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  writeSourceFile(directory, 'SHA256SUMS', `${hash}  ${name}\n`);
}

function runFixture({ tag, channel, signing, artifactName, noticeName, noticeText }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ripple-release-dry-run-'));
  const sourceDir = path.join(root, 'source');
  const assetsDir = path.join(root, 'public-assets');
  const notesFile = path.join(root, 'release-notes.md');
  fs.mkdirSync(sourceDir);
  makeArtifact(sourceDir, artifactName, Buffer.from(`dummy ${artifactName}\n`));
  writeSourceFile(sourceDir, noticeName, noticeText);
  writeSourceFile(sourceDir, 'RELEASING.md', '# Test release runbook\n');
  const manifest = prepareRelease({
    ...BASE,
    tag,
    channel,
    signing,
    sourceDir,
    assetsDir,
    notesFile,
  });
  return { root, sourceDir, assetsDir, notesFile, manifest };
}

function testSignedStableBundle() {
  const fixture = runFixture({
    tag: 'v1.2.3',
    channel: 'stable',
    signing: 'store-ready',
    artifactName: 'ripple-v1.2.3-store-ready.aab',
    noticeName: 'SIGNING-NOTICE.txt',
    noticeText: 'STORE-UPLOAD-READY AAB signed with the configured Play upload key.\n',
  });
  assert.deepEqual(fixture.manifest.assets.map((asset) => asset.name), [
    'RELEASING.md',
    'SHA256SUMS',
    'SIGNING-NOTICE.txt',
    'ripple-v1.2.3-store-ready.aab',
  ]);
  const notes = fs.readFileSync(fixture.notesFile, 'utf8');
  assert.match(notes, /signed with the configured Ripple Google Play upload key/);
  assert.match(notes, /workflow run/);
  assert.match(notes, /debug APK[\s\S]*field testing/);
  assert.match(notes, /Android-only release/);
  assert.match(notes, /unsigned iOS archive may be uploaded separately as a workflow artifact/i);
  assert.doesNotMatch(notes, /not store-ready/);
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

function testUnsignedStableBundle() {
  const fixture = runFixture({
    tag: 'v2.0.0',
    channel: 'stable',
    signing: 'unsigned',
    artifactName: 'ripple-v2.0.0-unsigned.aab',
    noticeName: 'SIGNING-NOTICE.txt',
    noticeText: 'UNSIGNED AAB — not store-ready. Do not upload this file to Google Play.\n',
  });
  const notes = fs.readFileSync(fixture.notesFile, 'utf8');
  assert.match(notes, /unsigned and not store-ready/);
  assert.match(notes, /Do not upload it to Google Play/);
  assert.equal(fixture.manifest.assets.length, 4);
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

function testPrereleaseDebugApk() {
  const fixture = runFixture({
    tag: 'v1.2.3-rc.1',
    channel: 'prerelease',
    signing: 'none',
    artifactName: 'ripple-v1.2.3-rc.1-debug.apk',
    noticeName: 'ARTIFACT-NOTICE.txt',
    noticeText: 'DEBUG-SIGNED APK — for field testing only; this is not store-ready.\n',
  });
  const notes = fs.readFileSync(fixture.notesFile, 'utf8');
  assert.match(notes, /Pre-release for field testing/);
  assert.match(notes, /debug-signed APK[\s\S]*not store-ready/);
  assert.match(notes, /unsigned iOS archive may be uploaded separately as a workflow artifact/i);
  assert.equal(fixture.manifest.assets.length, 4);
  assert.equal(fixture.manifest.assets.some((asset) => asset.name.endsWith('.aab')), false);
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

function testRejectsChecksumMismatch() {
  const fixture = runFixture({
    tag: 'v3.0.0',
    channel: 'stable',
    signing: 'unsigned',
    artifactName: 'ripple-v3.0.0-unsigned.aab',
    noticeName: 'SIGNING-NOTICE.txt',
    noticeText: 'UNSIGNED AAB — not store-ready.\n',
  });
  writeSourceFile(fixture.sourceDir, 'ripple-v3.0.0-unsigned.aab', 'changed after checksum\n');
  assert.throws(
    () => prepareRelease({
      ...BASE,
      tag: 'v3.0.0',
      channel: 'stable',
      signing: 'unsigned',
      sourceDir: fixture.sourceDir,
      assetsDir: path.join(fixture.root, 'bad-assets'),
      notesFile: path.join(fixture.root, 'bad-notes.md'),
    }),
    /SHA-256 mismatch/,
  );
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

function testRejectsChannelMismatch() {
  assert.throws(() => prepareRelease({
    ...BASE,
    tag: 'v1.2.3-rc.1',
    channel: 'stable',
    signing: 'unsigned',
    sourceDir: '/tmp/not-read',
    assetsDir: '/tmp/not-written',
    notesFile: '/tmp/not-written.md',
  }), /is a prerelease tag/);
}

for (const test of [
  testSignedStableBundle,
  testUnsignedStableBundle,
  testPrereleaseDebugApk,
  testRejectsChecksumMismatch,
  testRejectsChannelMismatch,
]) {
  test();
}

console.log('Release payload dry-run: 5 tests passed (signed/unsigned stable, prerelease APK, checksum and channel validation).');
