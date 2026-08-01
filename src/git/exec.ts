import { execFile } from 'node:child_process'

/**
 * Thrown when git exits non-zero. Carries stderr so callers can pattern-match on git's
 * own wording (e.g. detecting an empty repo) instead of guessing from exit codes.
 */
export class GitError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
    readonly args: string[],
  ) {
    super(message)
    this.name = 'GitError'
  }
}

export interface GitOptions {
  /** Milliseconds before the child is killed. Guards against a wedged git process. */
  timeoutMs?: number
  /** Max stdout bytes. `git log` on a huge repo can be large; default is generous. */
  maxBuffer?: number
}

/**
 * Run git in `cwd` and return stdout.
 *
 * Uses `execFile`, never a shell, so branch names, paths and refs containing shell
 * metacharacters cannot be interpreted as commands. Every argument reaches git verbatim.
 *
 * The environment is pinned so output does not shift under the user's config:
 * `LC_ALL=C` for stable messages, and `--no-pager` / `core.pager=cat` so git never tries
 * to page into a non-tty. `GIT_OPTIONAL_LOCKS=0` is the important one — it stops
 * read commands from taking `index.lock`, so we can never contend with the user's
 * terminal. That is what makes "read-only" true in practice and not just in intent.
 */
export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  const { timeoutMs = 15_000, maxBuffer = 256 * 1024 * 1024 } = opts

  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['--no-pager', ...args],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer,
        windowsHide: true,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
          GIT_PAGER: 'cat',
          LC_ALL: 'C',
        },
      },
      (err, stdout, stderr) => {
        if (err) {
          const code = typeof (err as { code?: unknown }).code === 'number'
            ? ((err as { code: number }).code)
            : null
          reject(
            new GitError(
              `git ${args.join(' ')} failed: ${stderr.trim() || err.message}`,
              code,
              stderr,
              args,
            ),
          )
          return
        }
        resolve(stdout)
      },
    )
  })
}

/** Run git and return null instead of throwing. For probes where failure is expected. */
export async function gitOrNull(
  cwd: string,
  args: string[],
  opts: GitOptions = {},
): Promise<string | null> {
  try {
    return await git(cwd, args, opts)
  } catch {
    return null
  }
}
