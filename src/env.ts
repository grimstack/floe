import { EnvFieldSpec, EnvOutput, FloeEnvError } from './types.js'

// ─── Coerce raw string value into typed output ────────────────────────────────

function coerce(key: string, raw: string, spec: EnvFieldSpec): unknown {
  if (spec.type === 'number') {
    const n = Number(raw)
    if (Number.isNaN(n)) {
      throw { key, reason: `expected number, got "${raw}"` }
    }
    return n
  }

  if (spec.type === 'boolean') {
    if (raw === 'true' || raw === '1')  return true
    if (raw === 'false' || raw === '0') return false
    throw { key, reason: `expected boolean (true/false/1/0), got "${raw}"` }
  }

  if (spec.enum && !spec.enum.includes(raw)) {
    throw { key, reason: `expected one of [${spec.enum.join(', ')}], got "${raw}"` }
  }

  return raw
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Validate and parse process.env against a schema.
 * Fails at startup with a clear, complete error — not silently at runtime.
 *
 * @example
 * const config = env({
 *   DATABASE_URL: { required: true },
 *   PORT: { type: 'number', default: 3000 },
 *   NODE_ENV: { enum: ['development', 'production', 'test'] },
 * })
 * // config.PORT → number (TypeScript inferred)
 */
export function env<S extends Record<string, EnvFieldSpec>>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): EnvOutput<S> {
  const result: Record<string, unknown> = {}
  const missing: string[] = []
  const invalid: Array<{ key: string; reason: string }> = []

  for (const [key, spec] of Object.entries(schema)) {
    const raw = source[key]

    // Value present — coerce and validate
    if (raw !== undefined && raw !== '') {
      try {
        result[key] = coerce(key, raw, spec)
      } catch (e) {
        invalid.push(e as { key: string; reason: string })
      }
      continue
    }

    // Value absent — use default if provided
    if ('default' in spec && spec.default !== undefined) {
      result[key] = spec.default
      continue
    }

    // Value absent — optional field
    if (spec.required === false) {
      continue
    }

    // Value absent — required
    missing.push(key)
  }

  if (missing.length > 0 || invalid.length > 0) {
    const lines: string[] = ['\n[floe] Environment validation failed:\n']

    if (missing.length > 0) {
      lines.push('  Missing required variables:')
      for (const key of missing) {
        const desc = schema[key]?.description
        lines.push(`    ${key.padEnd(24)} required${desc ? ` — ${desc}` : ''}`)
      }
    }

    if (invalid.length > 0) {
      if (missing.length > 0) lines.push('')
      lines.push('  Invalid values:')
      for (const { key, reason } of invalid) {
        lines.push(`    ${key.padEnd(24)} ${reason}`)
      }
    }

    lines.push('\n  Fix your .env file and restart.\n')

    throw new FloeEnvError(lines.join('\n'), missing, invalid)
  }

  return Object.freeze(result) as EnvOutput<S>
}