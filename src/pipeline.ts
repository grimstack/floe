import {
  StageFunction,
  RetryOptions,
  RunOptions,
  PipelineResult,
  TraceEntry,
  FloeError,
} from './types.js'
import { withRetry } from './retry.js'

// ─── Internal stage descriptor ────────────────────────────────────────────────

type StageKind = 'pipe' | 'parallel' | 'catch'

interface Stage {
  kind: StageKind
  fn: StageFunction<unknown, unknown> | Array<StageFunction<unknown, unknown>>
  name: string
  retry?: RetryOptions
}

// ─── Pipeline builder ─────────────────────────────────────────────────────────

export class Pipeline<TInput, TOutput> {
  private readonly stages: Stage[]
  private readonly input: TInput

  constructor(input: TInput, stages: Stage[] = []) {
    this.input = input
    this.stages = stages
  }

  pipe<TNext>(fn: StageFunction<TOutput, TNext>): Pipeline<TInput, TNext> {
    return new Pipeline<TInput, TNext>(this.input, [
      ...this.stages,
      { kind: 'pipe', fn: fn as StageFunction<unknown, unknown>, name: fn.name || 'anonymous' },
    ])
  }

  retry(options: RetryOptions): Pipeline<TInput, TOutput> {
    if (this.stages.length === 0) {
      throw new Error('[floe] .retry() must follow a .pipe() stage')
    }
    const stages = [...this.stages]
    const last = stages[stages.length - 1]
    if (!last) throw new Error('[floe] internal: no stages')
    stages[stages.length - 1] = { kind: last.kind, fn: last.fn, name: last.name, retry: options }
    return new Pipeline<TInput, TOutput>(this.input, stages)
  }

  parallel<TResults extends unknown[]>(
    fns: { [K in keyof TResults]: StageFunction<TOutput, TResults[K]> },
  ): Pipeline<TInput, TResults> {
    return new Pipeline<TInput, TResults>(this.input, [
      ...this.stages,
      {
        kind: 'parallel',
        fn: fns as Array<StageFunction<unknown, unknown>>,
        name: `parallel(${fns.map(f => f.name || 'fn').join(', ')})`,
      },
    ])
  }

  catch<TFallback extends TOutput>(
    fn: (err: unknown) => TFallback | Promise<TFallback>,
  ): Pipeline<TInput, TOutput> {
    if (this.stages.length === 0) {
      throw new Error('[floe] .catch() must follow a .pipe() stage')
    }
    const stages = [...this.stages]
    const last = stages[stages.length - 1]
    if (!last) throw new Error('[floe] internal: no stages')
    const originalFn = last.fn as StageFunction<unknown, unknown>
    const wrappedFn: StageFunction<unknown, unknown> = async (input) => {
      try {
        return await originalFn(input)
      } catch (err) {
        return await fn(err)
      }
    }
    Object.defineProperty(wrappedFn, 'name', { value: last.name })
    stages[stages.length - 1] = { kind: last.kind, fn: wrappedFn, name: last.name }
    return new Pipeline<TInput, TOutput>(this.input, stages)
  }

  // Overloads
  async run(options?: RunOptions & { result?: false }): Promise<TOutput>
  async run(options: RunOptions & { result: true }): Promise<PipelineResult<TOutput>>
  async run(options: RunOptions = {}): Promise<TOutput | PipelineResult<TOutput>> {
    const { trace: enableTrace = false, result: returnResult = false } = options
    const traceLog: TraceEntry[] = []
    let current: unknown = this.input

    for (const stage of this.stages) {
      const start = Date.now()

      try {
        if (stage.kind === 'parallel') {
          const fns = stage.fn as Array<StageFunction<unknown, unknown>>
          current = await Promise.all(fns.map(fn => fn(current)))
          if (enableTrace) {
            traceLog.push({ stage: stage.name, durationMs: Date.now() - start, status: 'ok' })
          }
          continue
        }

        const fn = stage.fn as StageFunction<unknown, unknown>

        if (stage.retry) {
          const { value, attempts } = await withRetry(
            () => fn(current) as Promise<unknown>,
            stage.name,
            stage.retry,
          )
          current = value
          if (enableTrace) {
            traceLog.push({
              stage: stage.name,
              durationMs: Date.now() - start,
              status: attempts > 1 ? 'retried' : 'ok',
              attempts,
            })
          }
        } else {
          current = await fn(current)
          if (enableTrace) {
            traceLog.push({ stage: stage.name, durationMs: Date.now() - start, status: 'ok' })
          }
        }
      } catch (err) {
        const floeErr = err instanceof FloeError
          ? err
          : new FloeError(
              `[floe] Stage "${stage.name}" threw: ${(err as Error)?.message ?? String(err)}`,
              stage.name,
              err,
            )

        if (enableTrace) {
          traceLog.push({ stage: stage.name, durationMs: Date.now() - start, status: 'error' })
          printTrace(traceLog)
        }

        if (returnResult) {
          const out: PipelineResult<TOutput> = { ok: false, error: floeErr }
          if (enableTrace) out.trace = traceLog
          return out
        }
        throw floeErr
      }
    }

    if (enableTrace) printTrace(traceLog)

    if (returnResult) {
      const out: PipelineResult<TOutput> = { ok: true, value: current as TOutput }
      if (enableTrace) out.trace = traceLog
      return out
    }

    return current as TOutput
  }
}

// ─── Trace printer ────────────────────────────────────────────────────────────

function printTrace(entries: TraceEntry[]): void {
  const totalMs = entries.reduce((sum, e) => sum + e.durationMs, 0)
  const nameWidth = Math.max(...entries.map(e => e.stage.length), 10)
  console.log('\n[floe] pipeline trace:')
  for (const entry of entries) {
    const status =
      entry.status === 'retried' ? `retried(${entry.attempts ?? '?'})` :
      entry.status === 'error'   ? 'error' :
      'ok'
    console.log(`  ${entry.stage.padEnd(nameWidth)}  ${String(entry.durationMs).padStart(5)}ms  ${status}`)
  }
  console.log(`  ${'total'.padEnd(nameWidth)}  ${String(totalMs).padStart(5)}ms\n`)
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export function pipeline<T>(input: T): Pipeline<T, T> {
  return new Pipeline<T, T>(input)
}