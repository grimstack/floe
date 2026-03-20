// ─── Env types ────────────────────────────────────────────────────────────────

export type EnvFieldSpec =
  | { required?: true;  type?: 'string';  default?: string;  enum?: ReadonlyArray<string>; description?: string }
  | { required?: true;  type: 'number';   default?: number;  description?: string }
  | { required?: true;  type: 'boolean';  default?: boolean; description?: string }
  | { required: false;  type?: 'string';  default?: string;  enum?: ReadonlyArray<string>; description?: string }
  | { required: false;  type: 'number';   default?: number;  description?: string }
  | { required: false;  type: 'boolean';  default?: boolean; description?: string }

type InferEnvField<F extends EnvFieldSpec> =
  F extends { enum: ReadonlyArray<infer E> }
    ? E
    : F extends { type: 'number' }
      ? number
      : F extends { type: 'boolean' }
        ? boolean
        : string

type IsRequired<F extends EnvFieldSpec> =
  F extends { required: false }
    ? false
    : F extends { default: unknown }
      ? false
      : true

type InferEnvSchema<S extends Record<string, EnvFieldSpec>> = {
  [K in keyof S as IsRequired<S[K]> extends true ? K : never]: InferEnvField<S[K]>
} & {
  [K in keyof S as IsRequired<S[K]> extends false ? K : never]?: InferEnvField<S[K]>
}

export type EnvOutput<S extends Record<string, EnvFieldSpec>> =
  Readonly<{ [K in keyof InferEnvSchema<S>]: InferEnvSchema<S>[K] }>

// ─── Pipeline types ───────────────────────────────────────────────────────────

export type StageFunction<In, Out> = (input: In) => Out | Promise<Out>

export interface RetryOptions {
  attempts?: number
  backoff?: 'fixed' | 'linear' | 'exponential'
  delayMs?: number
  jitter?: boolean
  on?: (err: unknown) => boolean
  breaker?: CircuitBreaker
}

export interface RunOptions {
  trace?: boolean
  result?: boolean
}

export interface TraceEntry {
  stage: string
  durationMs: number
  status: 'ok' | 'error' | 'retried'
  attempts?: number
}

export interface PipelineResult<T> {
  ok: boolean
  value?: T
  error?: FloeError
  trace?: TraceEntry[]
}

// ─── Error types ──────────────────────────────────────────────────────────────

export class FloeError extends Error {
  constructor(
    message: string,
    public readonly stage: string,
    public readonly cause?: unknown,
    public readonly attempts?: number,
  ) {
    super(message)
    this.name = 'FloeError'
  }
}

export class FloeEnvError extends Error {
  constructor(
    message: string,
    public readonly missing: string[],
    public readonly invalid: Array<{ key: string; reason: string }>,
  ) {
    super(message)
    this.name = 'FloeEnvError'
  }
}

// ─── Circuit breaker types ────────────────────────────────────────────────────

export interface CircuitBreakerOptions {
  threshold: number
  window: number
  resetAfter?: number
}

export type CircuitState = 'closed' | 'open' | 'half-open'

export interface CircuitBreaker {
  state: CircuitState
  record(success: boolean): void
  canAttempt(): boolean
}