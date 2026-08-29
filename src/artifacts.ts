import fs from "node:fs";

export type ArtifactFile = { path: string; contents: string };
/** Injectable so the rollback path can be provoked deterministically instead of hoped for. */
export type ArtifactIo = {
  exists: (filePath: string) => boolean;
  read: (filePath: string) => Buffer;
  write: (filePath: string, contents: string | Buffer) => void;
  rename: (from: string, to: string) => void;
  remove: (filePath: string) => void;
};

export const nodeArtifactIo: ArtifactIo = {
  exists: (filePath) => fs.existsSync(filePath),
  read: (filePath) => fs.readFileSync(filePath),
  write: (filePath, contents) => fs.writeFileSync(filePath, contents),
  rename: (from, to) => fs.renameSync(from, to),
  remove: (filePath) => fs.rmSync(filePath, { force: true }),
};

/**
 * Writes artifacts that are only valid as a set. A plain rename-per-file leaves the set mismatched
 * when a later rename fails, so the previous contents are captured first and restored on failure:
 * a failed write keeps the last valid set rather than inventing a new one. Files that did not exist
 * before are removed again, so a failure never leaves a half-written set behind either.
 */
export function writeArtifactPair(files: ArtifactFile[], io: ArtifactIo = nodeArtifactIo): void {
  const previous = files.map((file) => (io.exists(file.path) ? io.read(file.path) : undefined));
  const temporaries = files.map((file) => `${file.path}.${process.pid}.tmp`);
  try {
    files.forEach((file, index) => io.write(temporaries[index], file.contents));
    files.forEach((file, index) => io.rename(temporaries[index], file.path));
  } catch (error) {
    files.forEach((file, index) => {
      const restore = previous[index];
      if (restore) io.write(file.path, restore);
      else io.remove(file.path);
    });
    throw error;
  } finally {
    temporaries.forEach((temporary) => io.remove(temporary));
  }
}
