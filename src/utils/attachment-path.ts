import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';

/** Remote clients may save only within the shared attachment directory. Local
 * stdio retains the original caller-chosen savePath behavior. */
export function attachmentSavePath(directory: string, filename: string, savePath?: string): string {
  const root = path.resolve(directory);
  const target = savePath ? path.resolve(savePath) : path.join(root, path.basename(filename));
  if (process.env.IMAP_MCP_TRANSPORT !== 'http') return target;
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('HTTP attachment writes must stay inside IMAP_DOWNLOAD_DIR.');
  }
  // Do not follow host-created symlinks from this writable mount into config.
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error('HTTP attachment writes cannot follow symbolic links.');
    }
  }
  return target;
}
