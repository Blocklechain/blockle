/**
 * Blocklings — public leaderboard reporter.
 *
 * When signed in to a Blockle account, posts the player's skill levels to the
 * accounts service so they appear on the public per-skill / total-level board
 * at /leaderboard. Debounced on level-ups, with one report shortly after boot.
 * Guests (no session) never report — the board is signed-in only.
 *
 * The server clamps every level 1..999 and sanitizes the name, so a tampered
 * client can't poison the board beyond a plausible score. Fire-and-forget:
 * any network failure is swallowed (reporting is best-effort, never blocking).
 */
import { events } from '../events'
import { SKILLS } from '../ids'

const ORIGIN = 'https://blockle.org'

let skillLevel: ((s: string) => number) | null = null
let playerName: (() => string) | null = null
let timer: ReturnType<typeof setTimeout> | null = null

function schedule(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void report(), 4000) // coalesce bursts of level-ups
}

async function report(): Promise<void> {
  if (!skillLevel || !playerName) return
  let token: string | null = null
  try { token = localStorage.getItem('blk_token') } catch { token = null }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-blockle-client': 'blocklings'
  }
  let creds: RequestCredentials = 'include'
  if (token) {
    headers['Authorization'] = 'Bearer ' + token
    creds = 'omit'
  } else {
    // Cookie session: need CSRF, and only report if actually signed in.
    try {
      const me = await fetch(ORIGIN + '/account/api/me', { credentials: 'include' })
      const mj = (await me.json()) as { user?: unknown; csrf?: string }
      if (!mj || !mj.user || typeof mj.csrf !== 'string') return
      headers['x-csrf-token'] = mj.csrf
    } catch {
      return
    }
  }

  const skills: Record<string, number> = {}
  for (const s of SKILLS) skills[s] = skillLevel(s)
  try {
    await fetch(ORIGIN + '/account/api/game/blocklings/skills', {
      method: 'POST',
      headers,
      credentials: creds,
      body: JSON.stringify({ name: playerName(), skills })
    })
  } catch {
    /* best-effort */
  }
}

/** Wire the skill + name sources and start reporting (level-ups + boot + auth). */
export function initLeaderboardReport(
  skillLevelFn: (s: string) => number,
  playerNameFn: () => string
): void {
  skillLevel = skillLevelFn
  playerName = playerNameFn
  events.on('level:up', () => schedule())
  events.on('auth:changed', ({ signedIn }) => {
    if (signedIn) schedule()
  })
  setTimeout(() => schedule(), 8000) // one report a few seconds after boot
}
