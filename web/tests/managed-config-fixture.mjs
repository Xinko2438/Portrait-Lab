// Use real owner-contained fixture roots so configuration tests exercise the
// production placement gate instead of introducing a test bypass in writers.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export function tmpdir() {
  const path=fileURLToPath(new URL('../../_work/config-tests/',import.meta.url));
  mkdirSync(path,{recursive:true});return path;
}
