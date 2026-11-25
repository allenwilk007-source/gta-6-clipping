// Writing a refresh token to disk.
//
// Three platforms were each doing this themselves, identically, and each had
// the same two holes. The write is atomic - temp file, then rename - but the
// temp file was always the same name, and `mode` only applies when a file is
// created. A leftover `.tmp` from a save that died before its rename keeps
// whatever permissions it already had, and the next token is written straight
// into it. So: remove any leftover first, and set the permissions after the
// write as well as during it, because only the second one is a fact.

import { chmod, rename, rm, writeFile } from 'node:fs/promises';

const OWNER_ONLY = 0o600;

/**
 * Write JSON to `path` as atomically and as privately as the platform allows.
 *
 * On Linux and macOS 0o600 means what it says. On Windows, Node maps mode
 * only to the read-only attribute and the file takes the directory's ACL, so
 * the token is readable by anything running as this user. That is a real
 * limit worth knowing rather than papering over: see PRIVACY.md.
 */
export async function writeSecret(path, value) {
  const temp = `${path}.tmp`;
  // A leftover from a crashed save would otherwise donate its permissions.
  await rm(temp, { force: true });
  await writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: OWNER_ONLY });
  try {
    await chmod(temp, OWNER_ONLY);
  } catch {
    // Windows, or a filesystem with no permission bits. The rename still
    // happens: a token the owner can read is the point, and refusing to save
    // it here would only mean asking them to sign in again every run.
  }
  await rename(temp, path);
}
