/**
 * Shell passthrough: parse, whitelist, and execute commands sandboxed to storageRoot.
 */

const ALLOWED_COMMANDS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "find",
  "grep",
  "wc",
  "tree",
  "stat",
]);

const MAX_STDOUT = 1024 * 1024; // 1 MB
const TIMEOUT_MS = 10_000;

/**
 * Parse a command string into argv, respecting single and double quotes.
 * No shell expansion — globs like *.md won't expand.
 */
export function parseCommand(cmd: string): string[] {
  const args: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === " " && !inSingle && !inDouble) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

/**
 * Validate and execute a shell command sandboxed to storageRoot.
 * Returns { stdout, stderr, exitCode, truncated }.
 * Throws on validation errors (non-whitelisted command, path traversal).
 */
export async function executeCommand(
  cmd: string,
  storageRoot: string
): Promise<ShellResult> {
  const argv = parseCommand(cmd.trim());

  if (argv.length === 0) {
    throw new ShellValidationError("Empty command");
  }

  const command = argv[0];
  if (!ALLOWED_COMMANDS.has(command)) {
    throw new ShellValidationError(
      `Command not allowed: ${command}. Allowed: ${[...ALLOWED_COMMANDS].join(", ")}`
    );
  }

  // Reject path traversal in any argument
  for (const arg of argv.slice(1)) {
    if (arg.includes("..")) {
      throw new ShellValidationError("Path traversal (..) is not allowed");
    }
  }

  const proc = Bun.spawn(argv, {
    cwd: storageRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: {},
  });

  // Set up timeout
  const timeout = setTimeout(() => {
    proc.kill();
  }, TIMEOUT_MS);

  try {
    const [stdoutBuf, stderrBuf] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).arrayBuffer(),
    ]);
    await proc.exited;

    const truncated = stdoutBuf.byteLength > MAX_STDOUT;
    const stdoutBytes = truncated
      ? stdoutBuf.slice(0, MAX_STDOUT)
      : stdoutBuf;

    let stdout = new TextDecoder().decode(stdoutBytes);
    if (truncated) {
      stdout += "\n[truncated]";
    }

    const stderr = new TextDecoder().decode(stderrBuf);

    return {
      stdout,
      stderr,
      exitCode: proc.exitCode ?? 1,
      truncated,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export class ShellValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShellValidationError";
  }
}
