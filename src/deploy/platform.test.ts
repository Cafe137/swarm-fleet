import assert from 'node:assert/strict';
import test from 'node:test';
import {
  artifactFor,
  assetFor,
  binaryNameFor,
  DEFAULT_PLATFORM,
  hostPlatform,
} from './platform.js';

test('every machine a participant might use maps to a built artifact', () => {
  assert.equal(hostPlatform('linux', 'x64'), 'linux-amd64');
  assert.equal(hostPlatform('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(hostPlatform('darwin', 'x64'), 'darwin-amd64');
  assert.equal(hostPlatform('win32', 'x64'), 'windows-amd64');
});

test('an unbuilt platform is refused with what it found, not a wrong download', () => {
  assert.throws(() => hostPlatform('linux', 'arm64'), /no viewer is built for linux\/arm64/);
});

test('the linux artifact name is unchanged, so deployed fleets keep working', () => {
  assert.equal(artifactFor(DEFAULT_PLATFORM), 'weeb-3-rs-hls-linux-amd64');
  assert.equal(assetFor(DEFAULT_PLATFORM), 'weeb-3-rs-hls-linux-amd64');
});

test('windows carries the suffix on the asset but not on the artifact', () => {
  assert.equal(artifactFor('windows-amd64'), 'weeb-3-rs-hls-windows-amd64');
  assert.equal(assetFor('windows-amd64'), 'weeb-3-rs-hls-windows-amd64.exe');
  assert.equal(binaryNameFor('windows-amd64'), 'weeb-3-rs-hls.exe');
  assert.equal(binaryNameFor('darwin-arm64'), 'weeb-3-rs-hls');
});
