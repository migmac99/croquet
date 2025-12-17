/**
 * User Presence Event Management
 *
 * Pure functions for batching user join/leave events matching the original Croquet reflector.
 * Events are batched within USERS_INTERVAL to reduce message frequency.
 */

// ============================================================================
// Constants (matching original reflector)
// ============================================================================

/** Batch users events within this interval (ms) */
export const USERS_INTERVAL = 200

/** Initial sequence number for sessions */
export const INITIAL_SEQ = 0xfffffff0 >>> 0 // 4294967280

// ============================================================================
// Types
// ============================================================================

/** User event batching state */
export interface UserEventBatch {
  usersJoined: string[]
  usersLeft: string[]
}

/** Users event payload structure */
export interface UsersPayload {
  what: 'users'
  active: number
  total: number
  joined?: string[]
  left?: string[]
  _size?: number
}

// ============================================================================
// Pure Functions
// ============================================================================

/** Create an empty user event batch */
export const createUserBatch = (): UserEventBatch => ({
  usersJoined: [],
  usersLeft: [],
})

/** Ensure batch arrays exist, returning initialized if needed */
export const ensureUserBatch = (usersJoined?: string[], usersLeft?: string[]): UserEventBatch => ({
  usersJoined: usersJoined ?? [],
  usersLeft: usersLeft ?? [],
})

/**
 * Queue a user join event (handles join-after-leave cancellation)
 * Returns the updated batch
 */
export const queueUserJoin = (batch: UserEventBatch, userId: string): UserEventBatch => {
  const { usersJoined, usersLeft } = batch

  // If user was in left array, remove from there instead of adding to joined
  const leftIdx = usersLeft.indexOf(userId)
  if (leftIdx !== -1) {
    return {
      usersJoined,
      usersLeft: [...usersLeft.slice(0, leftIdx), ...usersLeft.slice(leftIdx + 1)],
    }
  }

  // Only add if not already in joined array
  if (usersJoined.includes(userId)) return batch

  return {
    usersJoined: [...usersJoined, userId],
    usersLeft,
  }
}

/**
 * Queue a user leave event (handles leave-after-join cancellation)
 * Returns the updated batch
 */
export const queueUserLeave = (batch: UserEventBatch, userId: string): UserEventBatch => {
  const { usersJoined, usersLeft } = batch

  // If user was in joined array, remove from there instead of adding to left
  const joinedIdx = usersJoined.indexOf(userId)
  if (joinedIdx !== -1) {
    return {
      usersJoined: [...usersJoined.slice(0, joinedIdx), ...usersJoined.slice(joinedIdx + 1)],
      usersLeft,
    }
  }

  // Only add if not already in left array
  if (usersLeft.includes(userId)) return batch

  return {
    usersJoined,
    usersLeft: [...usersLeft, userId],
  }
}

/**
 * Build a users event payload
 */
export const buildUsersPayload = (activeCount: number, totalCount: number, joined: string[], left: string[]): UsersPayload => {
  const payload: UsersPayload = {
    what: 'users',
    active: activeCount,
    total: totalCount,
  }

  if (joined.length > 0) payload.joined = joined.filter(Boolean)
  if (left.length > 0) payload.left = left.filter(Boolean)

  // Add _size property for accounting (matches original reflector)
  payload._size = JSON.stringify(payload).length

  return payload
}

/**
 * Build a complete users event message
 */
export const buildUsersMessage = (time: number, seq: number, activeCount: number, totalCount: number, joined: string[], left: string[]): unknown[] => {
  const payload = buildUsersPayload(activeCount, totalCount, joined, left)
  return [time, seq, payload]
}

/**
 * Check if a batch has any events to send
 */
export const hasPendingEvents = (batch: UserEventBatch): boolean => batch.usersJoined.length > 0 || batch.usersLeft.length > 0

/**
 * Flush a batch (returns the events and clears the batch)
 */
export const flushBatch = (batch: UserEventBatch): { joined: string[]; left: string[]; cleared: UserEventBatch } => ({
  joined: batch.usersJoined,
  left: batch.usersLeft,
  cleared: createUserBatch(),
})

/**
 * Increment sequence number with uint32 wraparound
 */
export const incrementSeq = (seq: number): number => (seq + 1) >>> 0
