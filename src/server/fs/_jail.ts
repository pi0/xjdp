// Path jail — prevents traversal and symlink escapes

const path = globalThis.process?.getBuiltinModule?.("node:path") as typeof import("node:path");
const fs = globalThis.process?.getBuiltinModule?.("node:fs") as typeof import("node:fs");

export class PathJail {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Resolve a user-supplied path within the jail. Throws on escape. */
  resolve(userPath: string): string {
    // Treat absolute paths as relative to jail root (strip leading /)
    const resolved = path.isAbsolute(userPath)
      ? path.join(this.root, userPath)
      : path.resolve(this.root, userPath);

    // Catch path traversal
    const prefix = this.root === "/" ? "/" : this.root + path.sep;
    if (!resolved.startsWith(prefix) && resolved !== this.root) {
      throw new SecurityError("Path traversal denied");
    }

    // Follow symlinks and re-check (catches symlink escapes)
    // Only check realpath if the path exists
    if (fs.existsSync(resolved)) {
      const real = fs.realpathSync(resolved);
      if (!real.startsWith(prefix) && real !== this.root) {
        throw new SecurityError("Symlink escape denied");
      }
    }

    return resolved;
  }
}

export class SecurityError extends Error {
  readonly code = "SECURITY_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "SecurityError";
  }
}
