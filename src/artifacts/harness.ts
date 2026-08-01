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

/** Returns the model's analysis as a sanitised HTML fragment, ready for the chassis. */
export async function generateAnalysis(brief: string, options: HarnessOptions = {}): Promise<string> {
  const harness = options.harness ?? 'claude'
  const args = buildArgs(harness, options.model)
  const raw = await run(harness, args, brief, options)
  return sanitiseFragment(extractFragment(raw))
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
 * Recover the fragment from whatever the harness actually returned.
 *
 * The spec asks for a bare fragment and that is what arrives, but a model that wraps its
 * answer in a fence, prefixes a sentence, or ignores the instruction and returns a whole
 * document should still produce a working page rather than a file that renders as source
 * code. Cheap to do, and the failure it prevents is one you would have to read HTML to
 * diagnose.
 */
export function extractFragment(raw: string): string {
  const text = raw.trim()
  if (text === '') throw new HarnessError('The harness returned nothing.')

  const fenced = /```(?:html)?\s*\n([\s\S]*?)```/i.exec(text)
  let candidate = (fenced?.[1] ?? text).trim()

  // It returned a whole document anyway: keep the body and drop the chrome we supply.
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(candidate)
  if (body) candidate = body[1]!.trim()
  else candidate = candidate.replace(/^<!doctype[^>]*>/i, '').trim()

  if (!/<[a-z]/i.test(candidate)) {
    throw new HarnessError('The harness did not return any HTML.', candidate.slice(0, 500))
  }
  return candidate
}

/**
 * Strip anything executable out of the fragment.
 *
 * Worth doing carefully, because of where this ends up. A generated page is served from the
 * daemon's own origin, which is the origin holding the session cookie — so a script inside
 * one would run with the daemon's API reachable to it. And the fragment is derived from a
 * commit diff, which is content someone else can write: reviewing a branch from an
 * untrusted fork puts their text into the prompt that produces this page.
 *
 * This is the second of two defences and the weaker one; a regex is not a parser. The one
 * that actually holds is the `Content-Security-Policy` the response carries, which forbids
 * scripts at the browser rather than trusting this to have caught them. Both are here
 * because either alone is a single point of failure.
 */
export function sanitiseFragment(fragment: string): string {
  return fragment
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|base|form)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|base|form)\b[^>]*\/?>/gi, '')
    // Inline handlers: `onclick=`, `onerror=`, quoted or bare.
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(href|src|xlink:href)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]*)/gi, '')
}
