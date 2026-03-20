# @bytewraith/floe

Safe async data flow for Node.js and TypeScript.

Validated env at startup. Typed pipelines. Built-in retry and circuit breaker.  
Zero dependencies. ~4kb gzipped.

```bash
npm install @bytewraith/floe
```

---

## The problem

Every serious Node.js service does the same three things badly:

1. **Reads env vars** — scattered across the codebase, wrong type, discovered missing at runtime
2. **Chains async operations** — try/catch pyramids, type lost between steps, no retry logic
3. **Calls unreliable services** — hand-rolled retry loops copy-pasted between projects

`@bytewraith/floe` makes all three right, with one install and one mental model.

---

## `env()` — validate config at startup

Define a schema once. Get fully typed, validated config. Missing vars throw *before* your server starts — with a message that lists every problem at once.

```typescript
import { env } from '@bytewraith/floe'

const config = env({
  DATABASE_URL: { required: true },
  PORT:         { type: 'number', default: 3000 },
  NODE_ENV:     { enum: ['development', 'production', 'test'] as const },
  REDIS_URL:    { required: false, default: 'redis://localhost:6379' },
})

// TypeScript knows:
// config.DATABASE_URL → string
// config.PORT         → number  (not string — actually number)
// config.NODE_ENV     → 'development' | 'production' | 'test'

app.listen(config.PORT)
```

If `DATABASE_URL` is missing and `PORT` is `"banana"`:

```
[floe] Environment validation failed:

  Missing required variables:
    DATABASE_URL             required

  Invalid values:
    PORT                     expected number, got "banana"

  Fix your .env file and restart.
```

One pass. Every problem. No hunting.

---

## `pipeline()` — typed async stage composition

Chain async functions where each stage's output type is the next stage's input type. No casting. No `any`. No lies.

```typescript
import { pipeline } from '@bytewraith/floe'

const user = await pipeline(userId)        // string
  .pipe(fetchUser)                         // → User
  .pipe(enrichWithOrg)                     // → UserWithOrg
  .pipe(sendWelcomeEmail)                  // → EmailReceipt
  .run()
```

TypeScript enforces the chain. If `enrichWithOrg` returns `UserWithOrg` and `sendWelcomeEmail` expects a plain `User`, it's a compile error — not a runtime surprise.

### Parallel stages

```typescript
const report = await pipeline(reportId)
  .pipe(fetchReport)                            // → Report
  .parallel([fetchMetrics, fetchComments])      // → [Metrics, Comment[]]
  .pipe(buildReportPage)                        // → HTML
  .run()
```

Both `fetchMetrics` and `fetchComments` run simultaneously. The output is a typed tuple.

### Error recovery with `.catch()`

```typescript
const user = await pipeline(userId)
  .pipe(fetchUser)
  .catch(() => guestUser)       // fallback — pipeline continues
  .pipe(renderProfile)
  .run()
```

`.catch()` wraps the previous stage only. Subsequent stages continue with the fallback value.

### Result mode — no try/catch needed

```typescript
const { ok, value, error } = await pipeline(orderId)
  .pipe(fetchOrder)
  .pipe(chargePayment)
  .run({ result: true })

if (!ok) {
  console.error(`Failed at stage: ${error.stage}`)
  // error.stage → 'chargePayment'
  // error.cause → original error
}
```

---

## `.retry()` — resilience exactly where you need it

`.retry()` wraps the *previous* stage only. Surgical, not global.

```typescript
import { pipeline } from '@bytewraith/floe'

const data = await pipeline(query)
  .pipe(callExternalApi)
  .retry({
    attempts: 4,
    backoff:  'exponential',   // 'fixed' | 'linear' | 'exponential'
    jitter:   true,            // randomise delay to avoid thundering herd
    delayMs:  200,             // base delay (ms)
    on: (err) => (err as any).status !== 400,  // skip retry on client errors
  })
  .pipe(parseResponse)
  .run()
```

Only `callExternalApi` retries. `parseResponse` does not. This is how you actually think about your system.

### Backoff strategies

| Strategy      | Delay per attempt (base 200ms)  |
|---------------|---------------------------------|
| `fixed`       | 200ms, 200ms, 200ms             |
| `linear`      | 200ms, 400ms, 600ms             |
| `exponential` | 200ms, 400ms, 800ms, 1600ms     |

All strategies are capped at 30 seconds. `jitter: true` applies full jitter (uniform random in `[0, delay]`) to spread load across retries.

---

## `circuit()` — prevent cascade failures

A circuit breaker that opens after N failures in a rolling window, then half-opens to probe recovery.

```typescript
import { pipeline, circuit } from '@bytewraith/floe'

const breaker = circuit({
  threshold:  5,       // open after 5 failures
  window:     10_000,  // within a 10 second window
  resetAfter: 30_000,  // probe again after 30 seconds
})

// Share the breaker across multiple requests
const result = await pipeline(order)
  .pipe(chargePayment)
  .retry({ attempts: 3, breaker })
  .run({ result: true })

if (!result.ok && result.error?.message.includes('Circuit open')) {
  // fail fast — don't hammer the payment service
}
```

Circuit states: `closed` (normal) → `open` (blocking) → `half-open` (probing) → `closed`.

---

## Tracing

Pass `trace: true` to `.run()` for a timing breakdown of every stage:

```typescript
await pipeline(userId)
  .pipe(fetchUser)
  .pipe(enrichWithOrg)
  .retry({ attempts: 3 })
  .pipe(saveToCache)
  .run({ trace: true })
```

```
[floe] pipeline trace:
  fetchUser       12ms  ok
  enrichWithOrg   87ms  retried(2)
  saveToCache      3ms  ok
  total          102ms
```

---

## Error types

```typescript
import { FloeError, FloeEnvError } from '@bytewraith/floe'

// FloeError — thrown by pipeline stages
// .stage    → name of the function that failed
// .cause    → original error
// .attempts → number of attempts if retried

// FloeEnvError — thrown by env()
// .missing  → string[]  — list of missing required vars
// .invalid  → { key, reason }[]  — list of coercion failures
```

---

## API reference

### `env(schema, source?)`

| Field option | Type | Description |
|---|---|---|
| `required` | `boolean` | Default `true`. Set `false` to make optional. |
| `type` | `'string' \| 'number' \| 'boolean'` | Coerces and type-checks the value. Default `'string'`. |
| `default` | matching type | Used when var is absent. Makes field optional automatically. |
| `enum` | `string[]` | Validates value is one of the array members. Inferred as union type. |
| `description` | `string` | Shown in error messages. |

### `pipeline(input)`

| Method | Description |
|---|---|
| `.pipe(fn)` | Add a stage. `fn: (input: In) => Out \| Promise<Out>`. |
| `.retry(options)` | Wrap previous stage with retry logic. |
| `.parallel(fns)` | Run all `fns` against current value simultaneously. Returns tuple. |
| `.catch(fn)` | Recover from previous stage error. `fn: (err) => fallback`. |
| `.run(options?)` | Execute. `{ trace?: boolean, result?: boolean }`. |

### `circuit(options)`

| Option | Type | Description |
|---|---|---|
| `threshold` | `number` | Failures before opening. |
| `window` | `number` | Rolling window in ms. |
| `resetAfter` | `number` | Ms before probing (default: `window`). |

---

## Philosophy

`@bytewraith/floe` is built on three rules:

**Fail loud, fail early, fail once.** `env()` validates everything in a single pass at boot. You see every problem at once. You fix it once. Your server starts.

**Types flow, they don't get cast.** Every `.pipe()` is typed. The type of stage N's output is the type of stage N+1's input. TypeScript enforces this. There is no `as any` in `@bytewraith/floe`.

**Resilience is surgical, not global.** `.retry()` wraps the stage before it — not the whole pipeline. You choose exactly which operations need retry logic, because not all failures are equal.

---

## License

MIT