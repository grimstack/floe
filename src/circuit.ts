import { CircuitBreaker, CircuitBreakerOptions, CircuitState } from './types.js'

/**
 * Create a circuit breaker that opens after `threshold` failures
 * within a rolling `window` (ms), then half-opens after `resetAfter` (ms).
 *
 * @example
 * const breaker = circuit({ threshold: 5, window: 10_000 })
 * await pipeline(order)
 *   .pipe(chargePayment)
 *   .retry({ attempts: 3, breaker })
 *   .run()
 */
export function circuit(options: CircuitBreakerOptions): CircuitBreaker {
  const { threshold, window: windowMs, resetAfter = windowMs } = options

  let state: CircuitState = 'closed'
  let failures = 0
  let windowStart = Date.now()
  let openedAt: number | null = null

  return {
    get state() { return state },

    record(success: boolean) {
      const now = Date.now()

      // Reset rolling window
      if (now - windowStart > windowMs) {
        failures = 0
        windowStart = now
      }

      if (success) {
        if (state === 'half-open') {
          state = 'closed'
          failures = 0
          openedAt = null
        }
        return
      }

      // Failure
      failures++

      if (state === 'half-open') {
        // Back to open on failure in half-open
        state = 'open'
        openedAt = now
        return
      }

      if (failures >= threshold && state === 'closed') {
        state = 'open'
        openedAt = now
      }
    },

    canAttempt(): boolean {
      if (state === 'closed') return true

      if (state === 'open' && openedAt !== null) {
        if (Date.now() - openedAt >= resetAfter) {
          state = 'half-open'
          return true
        }
        return false
      }

      // half-open: allow one probe
      return state === 'half-open'
    },
  }
}