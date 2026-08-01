import { createReadStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

/**
 * Every assumption about Claude Code lives here.
 *
 * The transcript layout and the on-disk directory scheme are not stable public contracts —
 * they are internal formats that happen to be readable. So a format change has to be a
 * one-file fix, which is the entire reason this module exists as a boundary rather than
 * being spread through the store.
 *
 * The whole feature is optional. No Claude Code installed, no transcripts for this repo,
 * an unrecognised record shape — every one of those degrades to "no session data" with no
 * error surfaced. Tier A liveness never depends on anything in this file.
 *
 * Verified against the 214 transcripts on the development machine.
 */

/** Where transcripts live. Overridable for tests. */
export function transcriptRoot(home = homedir()): string {
  return path.join(home, '.claude', 'projects')
}

/**
 * Where the live-session registry lives — one `<pid>.json` per running session.
 *
 * Separate from the transcripts and separate from the graph: a transcript is a record of
 * what happened, this is a claim about what is happening. Overridable for tests.
 */
export function sessionRegistryRoot(home = homedir()): string {
  return path.join(home, '.claude', 'sessions')
}

/** A session Claude Code says is running right now. */
export interface LiveSession {
  sessionId: string
  pid: number
  /**
   * Claude Code's own word for what the session is doing — `busy`, `idle`, `waiting` and
   * `shell` are the values seen. Deliberately typed as a string rather than a union: a
   * value we have not seen before should reach the UI verbatim, not be dropped for failing
   * to match a list written today.
   */
  status: string | null
}

/**
 * Which sessions are alive, keyed by session id.
 *
 * This is the one thing about a session that is *not* inferred. Attribution and idle
 * windows are guesses from timing; this is a registry entry naming a pid, and a pid either
 * exists or it does not. A session with no entry here is not running.
 *
 * Liveness is `process.kill(pid, 0)` — a signal-0 probe, which checks for the process and
 * delivers nothing. It is a syscall, not a spawn, so `git/exec.ts` remains the only place
 * in the project that starts a process. `EPERM` counts as alive: the process exists and
 * merely belongs to another user, which cannot happen for a session of our own but is the
 * safe reading if it ever does.
 *
 * **Pid reuse is the one false positive available.** A session that dies without cleaning
 * up leaves its file behind, and the kernel could eventually hand that pid to something
 * else. Verifying `procStart` against the real process start time would close it, and
 * would cost a `ps` spawn to do it — not worth it for a mark on a band. The stale entry
 * would additionally have to name a session that committed to *this* repository before
 * anything showed, since the caller joins on session id.
 *
 * Tier B throughout: no registry, no directory, unparseable JSON, an entry missing a pid —
 * every one of them means "nothing is known to be live", never an error.
 */
export async function readLiveSessions(
  options: { home?: string } = {},
): Promise<Map<string, LiveSession>> {
  const live = new Map<string, LiveSession>()
  const base = sessionRegistryRoot(options.home)

  let entries: string[]
  try {
    entries = (await readdir(base)).filter((f) => f.endsWith('.json'))
  } catch {
    return live // No Claude Code, or a version that does not keep a registry.
  }

  for (const entry of entries) {
    let record: Record<string, unknown>
    try {
      record = JSON.parse(await readFile(path.join(base, entry), 'utf8')) as Record<string, unknown>
    } catch {
      continue // Being rewritten as we read it, or not JSON at all.
    }

    const sessionId = str(record.sessionId)
    const pid = num(record.pid)
    if (sessionId === null || pid <= 0) continue
    if (!pidAlive(pid)) continue

    /*
     * Two live entries for one session id should not happen. If it ever does, the later
     * file wins rather than the first — a resumed session is likelier to be the one still
     * running than the entry that was already there.
     */
    live.set(sessionId, { sessionId, pid, status: str(record.status) })
  }

  return live
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Map a working-directory path to its transcript directory name.
 *
 * The scheme is `[^a-zA-Z0-9] → -`, verified across 26 directories: separators, dots,
 * spaces and underscores all collapse to a hyphen, so
 * `/Users/x/3E8-Robotics/Blueprint_ForgeCAD_Setup` becomes
 * `-Users-x-3E8-Robotics-Blueprint-ForgeCAD-Setup`.
 *
 * It is **lossy and non-invertible** — `a_b`, `a.b` and `a b` all produce `a-b`. Always
 * map forward from a known path. Never parse a directory name back into a path.
 */
export function escapeProjectPath(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** A human turn in the conversation. */
export interface SessionPrompt {
  /** Epoch milliseconds. */
  at: number
  text: string
}

export interface SessionRecord {
  sessionId: string
  /** Absolute path to the `.jsonl` transcript. */
  file: string
  /** Directory this session was launched in, per the transcript's own path. */
  projectDir: string
  /** Every distinct `cwd` seen. Sessions move between worktrees and subdirectories. */
  cwds: string[]
  /** Every distinct `gitBranch` seen. */
  branches: string[]
  /** Epoch milliseconds of the first and last timestamped record. */
  start: number
  end: number
  /**
   * Every timestamp in order. Attribution needs the *nearest preceding* activity, not the
   * session's outer bounds — see docs/design/session-bands.md for why bounds fail.
   */
  activity: number[]
  /** Title Claude generated for the session, when it produced one. */
  title: string | null
  /** Human turns only, excluding tool results and sub-agent traffic. */
  prompts: SessionPrompt[]
  inputTokens: number
  outputTokens: number
  /** Last model seen on an assistant record. */
  model: string | null
  /** Claude Code version that wrote the transcript, for schema-drift diagnosis. */
  version: string | null
}

/** Enough to decide whether a cached parse is still valid. */
interface FileStamp {
  size: number
  mtimeMs: number
}

interface CacheEntry extends FileStamp {
  session: SessionRecord | null
}

/**
 * Parsed transcripts, keyed by path.
 *
 * Transcripts get large — the biggest on the development machine is 52 MB — and the graph
 * refreshes on every commit. Re-reading them each time would dominate the update path
 * entirely, so a parse is reused until the file's size or mtime changes. Appends are the
 * normal case and do change both.
 */
const cache = new Map<string, CacheEntry>()

export function clearSessionCache(): void {
  cache.clear()
}

/**
 * Read every session whose work touched this repository.
 *
 * Candidate directories are computed by escaping the repo root and each worktree path.
 * That alone is not enough: a session launched in a *subdirectory* lands in its own
 * transcript directory, and `cwd` moves during a session anyway. So each transcript is
 * additionally accepted when any `cwd` it recorded lies inside one of the given roots.
 */
export async function readSessionsForRepo(
  roots: string[],
  options: { home?: string; signal?: AbortSignal } = {},
): Promise<SessionRecord[]> {
  const base = transcriptRoot(options.home)

  let entries: string[]
  try {
    entries = await readdir(base)
  } catch {
    return [] // No Claude Code on this machine. Entirely normal.
  }

  const normalisedRoots = roots.map((r) => path.resolve(r))
  const wanted = new Set(normalisedRoots.map(escapeProjectPath))

  // A directory whose name matches a root is definitely relevant. Others still might be —
  // a session launched in a subdirectory — so they are read and filtered on their cwds.
  const candidates = entries.filter((name) => {
    if (wanted.has(name)) return true
    return normalisedRoots.some((root) => name.startsWith(escapeProjectPath(root)))
  })

  const sessions: SessionRecord[] = []
  for (const dir of candidates) {
    const full = path.join(base, dir)
    let files: string[]
    try {
      files = (await readdir(full)).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }

    for (const file of files) {
      const session = await readSession(path.join(full, file))
      if (!session) continue
      if (!touchesRoots(session, normalisedRoots)) continue
      sessions.push(session)
    }
  }

  return sessions.sort((a, b) => a.start - b.start)
}

/** True when any recorded cwd is inside one of the roots. */
function touchesRoots(session: SessionRecord, roots: string[]): boolean {
  return session.cwds.some((cwd) =>
    roots.some((root) => cwd === root || cwd.startsWith(root + path.sep)),
  )
}

/**
 * Parse one transcript, memoised on size and mtime.
 *
 * Read line by line rather than into a string: a 52 MB file is over Node's default string
 * comfort zone, and only a few fields per record are ever wanted.
 */
export async function readSession(file: string): Promise<SessionRecord | null> {
  let stamp: FileStamp
  try {
    const info = await stat(file)
    stamp = { size: info.size, mtimeMs: info.mtimeMs }
  } catch {
    cache.delete(file)
    return null
  }

  const cached = cache.get(file)
  if (cached && cached.size === stamp.size && cached.mtimeMs === stamp.mtimeMs) {
    return cached.session
  }

  const session = await parseTranscript(file)
  cache.set(file, { ...stamp, session })
  return session
}

async function parseTranscript(file: string): Promise<SessionRecord | null> {
  const cwds = new Set<string>()
  const branches = new Set<string>()
  const activity: number[] = []
  const prompts: SessionPrompt[] = []

  let sessionId: string | null = null
  let title: string | null = null
  let model: string | null = null
  let version: string | null = null
  let inputTokens = 0
  let outputTokens = 0

  let stream
  try {
    stream = createReadStream(file, { encoding: 'utf8' })
  } catch {
    return null
  }

  const lines = createInterface({ input: stream, crlfDelay: Infinity })

  try {
    for await (const line of lines) {
      if (line === '') continue

      let record: Record<string, unknown>
      try {
        record = JSON.parse(line) as Record<string, unknown>
      } catch {
        // A partially written last line is expected while a session is live.
        continue
      }

      const type = str(record.type)
      sessionId ??= str(record.sessionId)
      version ??= str(record.version)

      const cwd = str(record.cwd)
      if (cwd) cwds.add(cwd)
      const branch = str(record.gitBranch)
      if (branch) branches.add(branch)

      const at = parseTime(record.timestamp)
      if (at !== null) activity.push(at)

      if (type === 'ai-title') {
        title = str(record.aiTitle) ?? title
        continue
      }

      if (type === 'user' && isHumanTurn(record) && at !== null) {
        const text = promptText(record)
        if (text) prompts.push({ at, text })
        continue
      }

      if (type === 'assistant') {
        const message = obj(record.message)
        model ??= str(message?.model)
        const usage = obj(message?.usage)
        if (usage) {
          // Cache reads and creations are real spend and dominate the total, so a token
          // figure that counted only `input_tokens` would be off by orders of magnitude.
          inputTokens +=
            num(usage.input_tokens) +
            num(usage.cache_read_input_tokens) +
            num(usage.cache_creation_input_tokens)
          outputTokens += num(usage.output_tokens)
        }
      }
    }
  } catch {
    return null // Unreadable mid-stream; treat as absent rather than failing the refresh.
  } finally {
    lines.close()
    stream.close()
  }

  if (activity.length === 0) return null

  activity.sort((a, b) => a - b)

  return {
    sessionId: sessionId ?? path.basename(file, '.jsonl'),
    file,
    projectDir: path.dirname(file),
    cwds: [...cwds],
    branches: [...branches],
    start: activity[0]!,
    end: activity[activity.length - 1]!,
    activity,
    title,
    prompts,
    inputTokens,
    outputTokens,
    model,
    version,
  }
}

/**
 * A turn typed by a person, as opposed to a tool result or sub-agent traffic.
 *
 * `type: 'user'` covers all three — tool results come back as user records too. Counting
 * them would inflate a two-prompt session into a hundred-prompt one.
 */
function isHumanTurn(record: Record<string, unknown>): boolean {
  if (record.isSidechain === true) return false
  if (record.isMeta === true) return false
  if (record.toolUseResult !== undefined) return false
  const origin = obj(record.origin)
  if (origin && str(origin.kind) !== 'human') return false
  return true
}

/** Prompt content is either a plain string or an array of content blocks. */
function promptText(record: Record<string, unknown>): string | null {
  const message = obj(record.message)
  const content = message?.content
  if (typeof content === 'string') return content.trim() || null

  if (Array.isArray(content)) {
    const text = content
      .map((block) => (typeof block === 'object' && block !== null ? str((block as Record<string, unknown>).text) : null))
      .filter((t): t is string => Boolean(t))
      .join('\n')
      .trim()
    return text || null
  }
  return null
}

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null
