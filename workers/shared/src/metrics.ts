/**
 * Prometheus-compatible metrics utilities
 * Shared across synchronizer, registry, and manager workers
 */

// Latency histogram buckets in milliseconds (matches original reflector buckets)
export const LATENCY_BUCKETS = [8, 10, 13, 17, 22, 29, 38, 50, 66, 87, 115, 153, 203, 270, 360] as const

// Session metrics tracked per-DO and reported to registry
export interface SessionMetrics {
  // Counters (cumulative since session start)
  messagesTotal: number // Total messages received (SEND)
  ticksTotal: number // Total ticks generated

  // Histogram buckets for latency distribution
  // Each bucket holds count of latencies <= bucket value
  // e.g., latencyBuckets[0] = count of latencies <= 8ms
  latencyBuckets: number[] // Length = LATENCY_BUCKETS.length (15)
  latencySum: number // Sum of all latency values (for computing mean)
  latencyCount: number // Total number of latency observations
}

// Create initial empty metrics
export function createEmptyMetrics(): SessionMetrics {
  return {
    messagesTotal: 0,
    ticksTotal: 0,
    latencyBuckets: new Array(LATENCY_BUCKETS.length).fill(0),
    latencySum: 0,
    latencyCount: 0,
  }
}

// Record a latency observation in the histogram
export function recordLatency(metrics: SessionMetrics, latencyMs: number): void {
  metrics.latencySum += latencyMs
  metrics.latencyCount++
  // Increment all buckets where latency <= bucket threshold
  for (let i = 0; i < LATENCY_BUCKETS.length; i++) {
    if (latencyMs <= LATENCY_BUCKETS[i]) {
      metrics.latencyBuckets[i]++
    }
  }
}
