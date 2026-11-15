/**
 * Release payload rules (Phase 5).
 *
 * The single tracked source of truth for the two flat archives that the
 * untracked package-release.mjs builds and install.sh / install.ps1 compose:
 *
 *   openbutler-daemon-<version>-<target>.<ext>   base payload: compiled app
 *                                                 minus the browser bundle
 *   openbutler-web-<version>-<target>.<ext>      overlay: only the browser
 *                                                 bundle (app/dist/client)
 *
 * Nothing is duplicated between the archives: the base carries the host, the
 * CLI and every runtime dependency, while the overlay is a thin layer the
 * installer extracts on top for installs that also serve the UI (`--web`).
 * A code-level split would be unsound - the static import graph (cli-main ->
 * daemon -> daemon-host) ties the CLI to the host - so the split exists in
 * data and install composition only. The installer roles (`--daemon` |
 * `--client`) never reach a file name: both roles fetch the same base bytes
 * and differ only in the post-install hint.
 */

/** The two archive flavors, in composition order. */
export const FLAVORS = ['daemon', 'web'];

/** Rejects anything that is not an explicit archive flavor. */
export function assertFlavor(flavor) {
  if (flavor === undefined || flavor === null || flavor === '') {
    throw new Error('--flavor is required: daemon or web.');
  }
  if (!FLAVORS.includes(flavor)) {
    throw new Error(`Unknown flavor: ${flavor} (expected daemon or web).`);
  }
  return flavor;
}

/**
 * The archive file name install.sh and install.ps1 must construct identically:
 * openbutler-<flavor>-<version>-<target>.<ext>
 */
export function archiveName(flavor, version, target, ext) {
  assertFlavor(flavor);
  return `openbutler-${flavor}-${version}-${target}.${ext}`;
}

/**
 * What one archive contains, as archive-root-relative paths:
 *
 *   daemon  the whole tree except the browser bundle: mode 'exclude'
 *   web     the browser bundle and nothing else:     mode 'only'
 *
 * The installers use this to merge the overlay into a base install; the
 * packager uses it to decide what it may copy into the archive.
 */
export function payloadSpec(flavor) {
  assertFlavor(flavor);
  if (flavor === 'daemon') return { mode: 'exclude', paths: ['app/dist/client'] };
  return { mode: 'only', paths: ['app/dist/client'] };
}