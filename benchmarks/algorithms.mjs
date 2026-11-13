import os from 'node:os';
import {
  evaluateFixedWindow,
  evaluateSlidingWindow,
  evaluateTokenBucket,
} from '../packages/core/dist/algorithms/index.js';

const fixedPolicy = { algorithm: 'fixed-window', limit: 100, windowMs: 1_000 };
const slidingPolicy = { algorithm: 'sliding-window', limit: 10_000, windowMs: 1_000 };
const tokenPolicy = {
  algorithm: 'token-bucket',
  limit: 100_000,
  capacity: 100_000,
  refillRate: 1_000,
  refillIntervalMs: 1_000,
};

function run(name, iterations, decide) {
  globalThis.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) decide(index);
  const elapsedMs = performance.now() - started;
  const heapDelta = process.memoryUsage().heapUsed - heapBefore;
  return {
    name,
    iterations,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    operationsPerSecond: Math.round(iterations / (elapsedMs / 1_000)),
    meanMicroseconds: Number(((elapsedMs * 1_000) / iterations).toFixed(3)),
    heapDeltaBytes: heapDelta,
  };
}

let fixedState;
const fixed = run('fixed-window', 100_000, (index) => {
  const result = evaluateFixedWindow(fixedPolicy, fixedState, 1, index);
  if (result.success) fixedState = result.nextState;
});

let slidingEvents = [];
const sliding = run('sliding-window', 20_000, (index) => {
  slidingEvents = slidingEvents.filter((event) => event.expiresAt > index);
  const result = evaluateSlidingWindow(slidingPolicy, slidingEvents, 1, index);
  if (result.success) slidingEvents.push({ createdAt: index, expiresAt: index + 1_000, cost: 1 });
});

let tokenState;
const token = run('token-bucket', 100_000, (index) => {
  const result = evaluateTokenBucket(tokenPolicy, tokenState, 1, index);
  if (result.success) tokenState = result.nextState;
});

console.log(
  JSON.stringify(
    {
      environment: {
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        osRelease: os.release(),
        cpu: os.cpus()[0]?.model ?? 'unknown',
        logicalCpus: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
      },
      method: 'Single-process pure algorithm calls; no Worker RPC, SQLite, alarms, or network.',
      results: [fixed, sliding, token],
    },
    null,
    2,
  ),
);
