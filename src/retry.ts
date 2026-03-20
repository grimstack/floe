import { RetryOptions, FloeError } from './types.js'

// ─── Backoff calculation ──────────────────────────────────────────────────────

function computeDelay(
  attempt: number,
  strategy: RetryOptions['backoff'],
  baseMs: number,
  jitter: boolean,
): number {
  let delay: number

  switch (strategy) {
    case 'linear':
      delay = baseMs * attempt
      break
    case 'exponential':
      delay = baseMs * Math.pow(2, attempt - 1)
      break
    case 'fixed':
    default:
      delay = baseMs
  }

  // Cap at 30 seconds
  delay = Math.min(delay, 30_000)

  // Full jitter: uniform random in [0, delay]
  if (jitter) {
    delay = Math.random() * delay
  }

  return delay
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ─── Core retry loop ──────────────────────────────────────────────────────────

export async function withRetry<T>(
  fn: () => Promise<T>,
  stageName: string,
  options: RetryOptions = {},
): Promise<{ value: T; attempts: number }> {
  const {
    attempts = 3,
    backoff = 'exponential',
    delayMs = 200,
    jitter = true,
    on: shouldRetry = () => true,
    breaker,
  } = options

  let lastError: unknown
  let attemptCount = 0

  for (let i = 1; i <= attempts; i++) {
    attemptCount = i

    // Circuit breaker check
    if (breaker && !breaker.canAttempt()) {
      throw new FloeError(
        `[floe] Circuit open — ${stageName} is not being attempted (too many recent failures)`,
        stageName,
        lastError,
        attemptCount,
      )
    }

    try {
      const value = await fn()
      breaker?.record(true)
      return { value, attempts: attemptCount }
    } catch (err) {
      lastError = err
      breaker?.record(false)

      // Don't retry if the caller says not to for this error
      if (!shouldRetry(err)) break

      // Last attempt — don't sleep, just fall through to throw
      if (i < attempts) {
        const delay = computeDelay(i, backoff, delayMs, jitter)
        await sleep(delay)
      }
    }
  }

  throw new FloeError(
    `[floe] Stage "${stageName}" failed after ${attemptCount} attempt${attemptCount > 1 ? 's' : ''}`,
    stageName,
    lastError,
    attemptCount,
  )
}