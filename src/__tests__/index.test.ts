import { env, pipeline, circuit, FloeError, FloeEnvError } from '../index.js'

// ─── env() ────────────────────────────────────────────────────────────────────

describe('env()', () => {
  it('returns typed values for all defined fields', () => {
    const config = env(
      {
        HOST:  { required: true },
        PORT:  { type: 'number', default: 3000 },
        DEBUG: { type: 'boolean', default: false },
      },
      { HOST: 'localhost', PORT: '8080', DEBUG: 'true' },
    )
    expect(config.HOST).toBe('localhost')
    expect(config.PORT).toBe(8080)
    expect(config.DEBUG).toBe(true)
  })

  it('uses defaults when vars are absent', () => {
    const config = env(
      { PORT: { type: 'number', default: 4000 } },
      {},
    )
    expect(config.PORT).toBe(4000)
  })

  it('throws FloeEnvError listing ALL missing vars in one pass', () => {
    expect(() =>
      env(
        {
          DATABASE_URL: { required: true },
          API_KEY:      { required: true },
          SECRET:       { required: true },
        },
        {},
      ),
    ).toThrow(FloeEnvError)

    try {
      env({ A: { required: true }, B: { required: true } }, {})
    } catch (e) {
      expect(e).toBeInstanceOf(FloeEnvError)
      expect((e as FloeEnvError).missing).toEqual(['A', 'B'])
    }
  })

  it('throws FloeEnvError on invalid type coercion', () => {
    expect(() =>
      env({ PORT: { type: 'number' } }, { PORT: 'not-a-number' }),
    ).toThrow(FloeEnvError)
  })

  it('validates enum membership', () => {
    expect(() =>
      env(
        { NODE_ENV: { enum: ['development', 'production'] as const } },
        { NODE_ENV: 'staging' },
      ),
    ).toThrow(FloeEnvError)

    const config = env(
      { NODE_ENV: { enum: ['development', 'production'] as const } },
      { NODE_ENV: 'development' },
    )
    expect(config.NODE_ENV).toBe('development')
  })

  it('treats required:false fields as optional — no error when absent', () => {
    const config = env(
      { OPTIONAL_FEATURE: { required: false } },
      {},
    )
    expect(config.OPTIONAL_FEATURE).toBeUndefined()
  })

  it('freezes the returned config object', () => {
    const config = env({ PORT: { type: 'number', default: 3000 } }, {})
    expect(Object.isFrozen(config)).toBe(true)
  })
})

// ─── pipeline() ───────────────────────────────────────────────────────────────

describe('pipeline()', () => {
  const double = (n: number) => n * 2
  const addOne = (n: number) => n + 1
  const toString = (n: number) => `value:${n}`

  it('chains synchronous transforms', async () => {
    const result = await pipeline(5).pipe(double).pipe(addOne).pipe(toString).run()
    expect(result).toBe('value:11')
  })

  it('chains async transforms', async () => {
    const asyncDouble = async (n: number) => n * 2
    const result = await pipeline(3).pipe(asyncDouble).pipe(addOne).run()
    expect(result).toBe(7)
  })

  it('returns a typed result with result:true', async () => {
    const result = await pipeline(10)
      .pipe(double)
      .run({ result: true })

    expect(result.ok).toBe(true)
    expect(result.value).toBe(20)
    expect(result.error).toBeUndefined()
  })

  it('captures error stage name on failure with result:true', async () => {
    const boom = (_: number): number => { throw new Error('db down') }
    const result = await pipeline(1)
      .pipe(double)
      .pipe(boom)
      .pipe(addOne)
      .run({ result: true })

    expect(result.ok).toBe(false)
    expect(result.error).toBeInstanceOf(FloeError)
    expect(result.error?.stage).toBe('boom')
  })

  it('throws FloeError on failure without result:true', async () => {
    const fail = () => { throw new Error('oops') }
    await expect(pipeline(1).pipe(fail).run()).rejects.toBeInstanceOf(FloeError)
  })

  it('runs stages in parallel and rejoins as tuple', async () => {
    const getA = async (n: number) => n * 2
    const getB = async (n: number) => `str-${n}`
    const combine = ([a, b]: [number, string]) => `${a}-${b}`

    const result = await pipeline(5)
      .parallel([getA, getB])
      .pipe(combine)
      .run()

    expect(result).toBe('10-str-5')
  })

  it('.catch() recovers from a stage error and continues', async () => {
    const fail = (_: number): number => { throw new Error('fail') }
    const result = await pipeline(1)
      .pipe(fail)
      .catch(() => 99)
      .pipe(addOne)
      .run()

    expect(result).toBe(100)
  })

  it('records trace entries when trace:true', async () => {
    const result = await pipeline(2)
      .pipe(double)
      .pipe(addOne)
      .run({ trace: true, result: true })

    expect(result.trace).toHaveLength(2)
    expect(result.trace?.[0]?.stage).toBe('double')
    expect(result.trace?.[1]?.stage).toBe('addOne')
    expect(result.trace?.[0]?.status).toBe('ok')
  })
})

// ─── .retry() ────────────────────────────────────────────────────────────────

describe('.retry()', () => {
  it('succeeds on a subsequent attempt', async () => {
    let calls = 0
    const flakey = async (_: number): Promise<number> => {
      calls++
      if (calls < 3) throw new Error('not yet')
      return 42
    }

    const result = await pipeline(0)
      .pipe(flakey)
      .retry({ attempts: 5, backoff: 'fixed', delayMs: 0, jitter: false })
      .run()

    expect(result).toBe(42)
    expect(calls).toBe(3)
  })

  it('throws FloeError after exhausting all attempts', async () => {
    const alwaysFails = async (_: number): Promise<number> => {
      throw new Error('always')
    }

    await expect(
      pipeline(0)
        .pipe(alwaysFails)
        .retry({ attempts: 3, backoff: 'fixed', delayMs: 0, jitter: false })
        .run(),
    ).rejects.toBeInstanceOf(FloeError)
  })

  it('respects the on() predicate — skips retry for 400 errors', async () => {
    let calls = 0
    const serverError = async (_: number): Promise<number> => {
      calls++
      const err = Object.assign(new Error('bad request'), { status: 400 })
      throw err
    }

    await expect(
      pipeline(0)
        .pipe(serverError)
        .retry({
          attempts: 5,
          backoff: 'fixed',
          delayMs: 0,
          jitter: false,
          on: (err) => (err as any).status !== 400,
        })
        .run(),
    ).rejects.toBeInstanceOf(FloeError)

    expect(calls).toBe(1) // only called once — no retry
  })

  it('includes attempt count in trace', async () => {
    let n = 0
    const flakey = async (_: number): Promise<number> => {
      if (++n < 2) throw new Error('retry me')
      return 1
    }

    const result = await pipeline(0)
      .pipe(flakey)
      .retry({ attempts: 3, backoff: 'fixed', delayMs: 0, jitter: false })
      .run({ trace: true, result: true })

    expect(result.trace?.[0]?.status).toBe('retried')
    expect(result.trace?.[0]?.attempts).toBe(2)
  })
})

// ─── circuit() ───────────────────────────────────────────────────────────────

describe('circuit()', () => {
  it('starts closed', () => {
    const breaker = circuit({ threshold: 3, window: 1000 })
    expect(breaker.state).toBe('closed')
    expect(breaker.canAttempt()).toBe(true)
  })

  it('opens after threshold failures', () => {
    const breaker = circuit({ threshold: 3, window: 10_000 })
    breaker.record(false)
    breaker.record(false)
    expect(breaker.state).toBe('closed')
    breaker.record(false)
    expect(breaker.state).toBe('open')
    expect(breaker.canAttempt()).toBe(false)
  })

  it('closes again after a success in half-open', () => {
    const breaker = circuit({ threshold: 1, window: 10_000, resetAfter: 0 })
    breaker.record(false)
    expect(breaker.state).toBe('open')
    // resetAfter: 0 means it immediately half-opens
    expect(breaker.canAttempt()).toBe(true)
    expect(breaker.state).toBe('half-open')
    breaker.record(true)
    expect(breaker.state).toBe('closed')
  })

  it('blocks pipeline when circuit is open', async () => {
    const breaker = circuit({ threshold: 1, window: 10_000, resetAfter: 60_000 })
    breaker.record(false) // open it

    const fn = jest.fn(async (_: number) => 42)
    await expect(
      pipeline(0)
        .pipe(fn)
        .retry({ attempts: 3, breaker })
        .run(),
    ).rejects.toBeInstanceOf(FloeError)

    expect(fn).not.toHaveBeenCalled()
  })
})