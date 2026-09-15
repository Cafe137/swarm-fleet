/**
 * Which viewer binary this machine can actually execute.
 *
 * A fleet on rented Linux boxes never had to ask: every host was
 * `linux-amd64` and the artifact name was a constant. A hand-driven run is
 * different — participants use whatever machine they already have, and a viewer
 * that cannot start there is a machine that cannot take part. So the platform
 * is a value, CI publishes one asset per platform, and the names below are the
 * interface between the two.
 *
 * `windows-amd64` is the one asymmetry: Windows will not execute a file without
 * the `.exe` suffix, so the asset carries it and the artifact name does not.
 */

export const VIEWER_PLATFORMS = [
  'linux-amd64',
  'darwin-arm64',
  'darwin-amd64',
  'windows-amd64',
] as const;
export type ViewerPlatform = (typeof VIEWER_PLATFORMS)[number];

/** What a fleet deploying to rented Linux machines wants, and the old default. */
export const DEFAULT_PLATFORM: ViewerPlatform = 'linux-amd64';

const BINARY_STEM = 'weeb-3-rs-hls';

/**
 * This machine's platform, or a refusal that says what it found.
 *
 * Deliberately narrow. Adding 32-bit x86, or Linux on ARM, means adding a CI
 * job first — claiming support the release does not carry would fail later, at
 * download time, with a worse message.
 */
export function hostPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ViewerPlatform {
  if (platform === 'linux' && arch === 'x64') {
    return 'linux-amd64';
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return 'darwin-arm64';
  }
  if (platform === 'darwin' && arch === 'x64') {
    return 'darwin-amd64';
  }
  if (platform === 'win32' && arch === 'x64') {
    return 'windows-amd64';
  }
  throw new Error(
    `no viewer is built for ${platform}/${arch}. CI builds ${VIEWER_PLATFORMS.join(', ')}; ` +
      'on anything else the viewer has to be built from source with `cargo build --release`.',
  );
}

/** The CI artifact name, which is also the release asset's prefix. */
export function artifactFor(platform: ViewerPlatform): string {
  return `${BINARY_STEM}-${platform}`;
}

/** The release asset, and the name the binary is saved under. */
export function assetFor(platform: ViewerPlatform): string {
  return platform === 'windows-amd64'
    ? `${BINARY_STEM}-${platform}.exe`
    : `${BINARY_STEM}-${platform}`;
}

/** What the binary must be called for the host to run it. */
export function binaryNameFor(platform: ViewerPlatform): string {
  return platform === 'windows-amd64' ? `${BINARY_STEM}.exe` : BINARY_STEM;
}

export function isWindows(platform: ViewerPlatform): boolean {
  return platform === 'windows-amd64';
}
