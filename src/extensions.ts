/**
 * Pure existence check over a list of Pi extension paths, shared by every startup path that needs
 * to fail fast on a dropped extension (the main drain path and the `reflect` subcommand). No
 * `console`/`process` here — callers own the error message and exit code.
 */
import { existsSync } from "node:fs";

/**
 * Returns the first path in `extensions` that does not exist on disk, in order, or `undefined` if
 * every path exists.
 */
export function firstMissingExtension(extensions: string[]): string | undefined {
  return extensions.find((ext) => !existsSync(ext));
}
