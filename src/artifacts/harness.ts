import { spawn } from 'node:child_process'
import { PAGE_SPEC } from './page-spec.js'

/**
 * Driving the local CLI.
 *
 * A subprocess rather than an API call, which is the decision that keeps this daemon
 * holding no credentials, storing no key, and opening no sockets of its own. Whichever
 * harness the user has already configured and authenticated is the one that runs. See
 * docs/design/artifacts.md.
 */

export type HarnessName = 'claude' | 'codex'

export interface HarnessOptions {
  harness?: HarnessName
  model?: string
  timeoutMs?: number
  signal?: AbortSignal
}

export class HarnessError extends Error {
  constructor(
    message: string,
    readonly detail: string = '',
  ) {
    super(message)
    this.name = 'HarnessError'
  }
}

/** Generation is a minutes-scale job on a large commit, not a seconds-scale one. */
const DEFAULT_TIMEOUT_MS = 240_000

export async function generatePage(brief: string, options: HarnessOptions = {}): Promise<string> {
  const harness = options.harness ?? 'claude'
  const args = buildArgs(harness, options.model)
  const raw = await run(harness, args, brief, options)
  return extractHtml(raw)
}

function buildArgs(harness: HarnessName, model?: string): string[] {
  if (harness === 'codex') {
    const args = ['exec']
    if (model) args.push('--model', model)
    return args
  }

  /*
   * `--tools ""` disables the built-in set outright.
   *
   * The model is writing a page from a brief already in its prompt; it has no reason to
   * touch the filesystem, and a generator that *can* run tools inside the user's repository
   * is a much larger security question than one that cannot. Restricting it here is
   * cheaper than auditing what it chose to do.
   */
  const args = ['-p', '--tools', '', '--append-system-prompt', PAGE_SPEC]
  if (model) args.push('--model', model)
  return args
}

function run(
  command: string,
  args: string[],
  input: string,
  options: HarnessOptions,
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      reject(new HarnessError(`Could not start ${command}.`, String(err)))
      return
    }

    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      fn()
    }

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(() =>
        reject(new HarnessError(`${command} did not finish within ${Math.round(timeoutMs / 1000)}s.`)),
      )
    }, timeoutMs)

    const onAbort = () => {
      child.kill('SIGTERM')
      finish(() => reject(new HarnessError('Generation was cancelled.')))
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))

    child.on('error', (err: NodeJS.ErrnoException) => {
      const message =
        err.code === 'ENOENT'
          ? `${command} is not installed, or not on PATH.`
          : `Could not run ${command}.`
      finish(() => reject(new HarnessError(message, err.message)))
    })

    child.on('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8')
      const errText = Buffer.concat(stderr).toString('utf8')
      if (code !== 0 && out.trim() === '') {
        finish(() => reject(new HarnessError(`${command} exited with code ${code}.`, errText.slice(0, 2000))))
        return
      }
      finish(() => resolve(out))
    })

    // A brief runs to tens of kilobytes, which is past what an argument list should carry.
    child.stdin?.on('error', () => {
      /* The child can exit before the whole brief is written; `close` reports the real
         failure, and an EPIPE here would otherwise crash the daemon. */
    })
    child.stdin?.end(input)
  })
}

/**
 * Recover the document from whatever the harness actually returned.
 *
 * The spec asks for bare HTML and the smoke tests produce exactly that, but a model that
 * wraps its answer in a fence — or prefixes a sentence — should degrade to a working page
 * rather than to a file that renders as source code. Cheap to do, and the failure it
 * prevents is one the user would have to read HTML to diagnose.
 */
export function extractHtml(raw: string): string {
  const text = raw.trim()
  if (text === '') throw new HarnessError('The harness returned nothing.')

  const fenced = /```(?:html)?\s*\n([\s\S]*?)```/i.exec(text)
  const candidate = fenced?.[1]?.trim() ?? text

  const start = candidate.search(/<!doctype html|<html[\s>]/i)
  if (start === -1) {
    throw new HarnessError(
      'The harness did not return an HTML document.',
      candidate.slice(0, 500),
    )
  }

  const end = candidate.toLowerCase().lastIndexOf('</html>')
  return end === -1 ? candidate.slice(start) : candidate.slice(start, end + '</html>'.length)
}
