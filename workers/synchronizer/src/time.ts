/**
 * Time and Tick Management
 *
 * Pure functions for time calculations matching the original Croquet reflector.
 * These handle scaled time (for pause/slowdown), raw time, and time advancement.
 */

import type { SessionState } from './types'

/** Get current wall-clock time (equivalent to stabilizedPerformanceNow in reflector) */
export const now = (): number => Date.now()

/** Generate a random timeline identifier for seamless rejoin support */
export const generateTimeline = (): string => Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2)

/** Answer true if seqB comes after seqA (wraparound-safe for uint32) */
export const after = (seqA: number, seqB: number): boolean => {
  const seqDelta = (seqB - seqA) >>> 0 // make unsigned
  return seqDelta > 0 && seqDelta < 0x80000000
}

/** Get scaled time for session (advances at session's scale rate) */
export const getScaledTime = (state: SessionState): number => {
  const sinceStart = now() - state.scaledStart
  return sinceStart * state.scale
}

/** Get raw time for session (ms since session started) */
export const getRawTime = (state: SessionState): number => Math.floor(now() - state.rawStart)

/**
 * Advance session time and return the new integer time
 *
 * This is the authoritative time source for the session. All messages
 * are timestamped with this value.
 */
export const advanceTime = (state: SessionState, reason?: string): number => {
  const prevTime = state.time
  const scaledTime = Math.floor(getScaledTime(state))
  state.time = scaledTime

  // Warn about time jumps (matches original reflector)
  const scaledAdvance = state.time - prevTime
  if (scaledAdvance < 0 || scaledAdvance > 60000) {
    console.warn(`[${state.id}] Time jump detected: ${scaledAdvance}ms`, {
      event: 'time-jump',
      scaledAdvance,
      prevTime,
      newTime: state.time,
      scaledStart: state.scaledStart,
      scale: state.scale,
      tick: state.tick,
      reason,
    })
  }

  return state.time
}

/**
 * Update session time scale (for pause/slowdown features)
 * Returns updated state fields to merge
 */
export const updateTimeScale = (state: SessionState, newScale: number, minScale: number, maxScale: number): { scale: number; scaledStart: number } => {
  const currentScaledTime = getScaledTime(state)
  const scaleToApply = Math.max(minScale, Math.min(maxScale, newScale))
  return {
    scale: scaleToApply,
    scaledStart: now() - currentScaledTime / scaleToApply,
  }
}
