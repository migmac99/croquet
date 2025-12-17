/**
 * TUTTI Tally Management
 *
 * Pure functions for Byzantine voting tallies matching the original Croquet reflector.
 * TUTTI allows clients to vote on state transitions with majority-wins consensus.
 */

import { now } from './time'

// ============================================================================
// Constants (matching original reflector)
// ============================================================================

/** Maximum time to wait to tally TUTTI contributions */
export const TALLY_INTERVAL = 1000

/** Don't start new tally if vote is more than this far behind */
export const MAX_TALLY_AGE = 60000

/** Maximum number of past tallies to remember */
export const MAX_COMPLETED_TALLIES = 20

// ============================================================================
// Types
// ============================================================================

/** Active tally waiting for votes */
export interface Tally {
  sendTime: number
  expecting: number
  payloads: Record<string, number> // payload hash -> vote count
  startedAt: number // For timeout tracking
  wantsVote?: boolean
  tallyTarget?: unknown
  firstMsg?: unknown[]
}

/** Tally storage state */
export interface TallyStorage {
  tallies: Record<string, Tally>
  completedTallies: Record<string, number> // tuttiKey -> sendTime
}

/** Result of completing a tally */
export interface TallyResult {
  tuttiKey: string
  sendTime: number
  payloads: Record<string, number>
  tallyTarget?: unknown
  missingClients: number
  shouldBroadcast: boolean
}

/** Result of processing a TUTTI vote */
export interface ProcessVoteResult {
  isNewTally: boolean
  tallyComplete: boolean
  rejected?: 'too_old' | 'already_completed'
  historyLimit?: number
  firstMsg?: unknown[]
}

// ============================================================================
// Pure Functions
// ============================================================================

/** Initialize empty tally storage */
export const createTallyStorage = (): TallyStorage => ({
  tallies: {},
  completedTallies: {},
})

/** Ensure tally storage exists, returning initialized if needed */
export const ensureTallyStorage = (tallies?: Record<string, Tally>, completedTallies?: Record<string, number>): TallyStorage => ({
  tallies: tallies ?? {},
  completedTallies: completedTallies ?? {},
})

/**
 * Clean up completed tallies and return the history limit
 * This prevents unbounded growth of completed tallies while maintaining
 * enough history to reject duplicate votes.
 */
export const cleanUpCompletedTallies = (
  completedTallies: Record<string, number>,
  currentTime: number
): { cleaned: Record<string, number>; historyLimit: number } => {
  // Calculate history limit based on MAX_TALLY_AGE
  let historyLimit = Math.max(0, currentTime - MAX_TALLY_AGE + 1)

  // Get send times that are recent enough to keep
  const sendTimesToKeep = Object.values(completedTallies).filter((time) => time >= historyLimit)

  // If too many recent tallies, cap at MAX_COMPLETED_TALLIES
  let newSentinel: number | undefined
  if (sendTimesToKeep.length > MAX_COMPLETED_TALLIES) {
    sendTimesToKeep.sort((a, b) => b - a) // descending, most recent first
    historyLimit = sendTimesToKeep[MAX_COMPLETED_TALLIES - 2] // leave room for sentinel
    newSentinel = sendTimesToKeep[MAX_COMPLETED_TALLIES - 1]
  }

  // Build cleaned record, keeping only entries >= historyLimit
  const sentinel = completedTallies[''] // sentinel entry has empty string key
  const cleaned: Record<string, number> = {}

  for (const [key, time] of Object.entries(completedTallies)) {
    if (time >= historyLimit) cleaned[key] = time
  }

  // Add sentinel if needed
  if (newSentinel !== undefined) cleaned[''] = newSentinel

  // Return the effective history limit
  const effectiveLimit = sentinel !== undefined ? sentinel : historyLimit

  return { cleaned, historyLimit: effectiveLimit }
}

/**
 * Check if a vote should be rejected based on age or completion status
 */
export const shouldRejectVote = (
  sendTime: number,
  tuttiKey: string,
  historyLimit: number,
  completedTallies: Record<string, number>
): 'too_old' | 'already_completed' | null => {
  if (sendTime < historyLimit) return 'too_old'
  if (completedTallies[tuttiKey] !== undefined) return 'already_completed'
  return null
}

/**
 * Create a new tally for a TUTTI vote
 */
export const createTally = (sendTime: number, activeClientCount: number, wantsVote?: boolean, tallyTarget?: unknown, firstMsg?: unknown[]): Tally => ({
  sendTime,
  expecting: activeClientCount,
  payloads: {},
  startedAt: now(),
  wantsVote,
  tallyTarget,
  firstMsg,
})

/**
 * Record a vote in a tally
 * Returns the new expecting count (decremented)
 */
export const recordVote = (tally: Tally, payload: string): number => {
  tally.payloads[payload] = (tally.payloads[payload] || 0) + 1
  return --tally.expecting
}

/**
 * Complete a tally and determine if result should be broadcast
 * Returns the result information without modifying state
 */
export const prepareTallyResult = (tuttiKey: string, tally: Tally): TallyResult => {
  const { sendTime, expecting: missing, wantsVote, tallyTarget, payloads } = tally

  // Send tally result if wantsVote or multiple different payloads (Byzantine detection)
  const shouldBroadcast = Boolean(wantsVote) || Object.keys(payloads).length > 1

  return {
    tuttiKey,
    sendTime,
    payloads,
    tallyTarget,
    missingClients: missing,
    shouldBroadcast,
  }
}

/**
 * Build a tally result message payload
 */
export const buildTallyMessage = (result: TallyResult): unknown => ({
  what: 'tally',
  sendTime: result.sendTime,
  tally: result.payloads,
  tallyTarget: result.tallyTarget,
  tuttiKey: result.tuttiKey,
  missingClients: result.missingClients,
})

/**
 * Mark a tally as completed (move from active to completed)
 */
export const completeTallyInStorage = (storage: TallyStorage, tuttiKey: string, sendTime: number): void => {
  delete storage.tallies[tuttiKey]
  storage.completedTallies[tuttiKey] = sendTime
}

/**
 * Find tallies that have timed out
 * Returns array of tuttiKeys that should be completed
 */
export const findTimedOutTallies = (tallies: Record<string, Tally>): string[] => {
  const currentTime = now()
  const timedOut: string[] = []

  for (const [tuttiKey, tally] of Object.entries(tallies)) {
    if (currentTime - tally.startedAt >= TALLY_INTERVAL) timedOut.push(tuttiKey)
  }

  return timedOut
}

/**
 * Parse TUTTI message arguments
 */
export const parseTuttiArgs = (
  args: unknown[]
): {
  sendTime: number
  payload: string
  firstMsg: unknown[] | undefined
  wantsVote: boolean | undefined
  tallyTarget: unknown
  tuttiKey: string
} => {
  const [sendTime, , payload, firstMsg, wantsVote, tallyTarget, tuttiKey] = args as [
    number,
    unknown,
    string,
    unknown[] | undefined,
    boolean | undefined,
    unknown,
    string,
  ]

  return {
    sendTime,
    payload: String(payload),
    firstMsg,
    wantsVote,
    tallyTarget,
    tuttiKey,
  }
}
