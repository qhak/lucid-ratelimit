# Benchmark methodology

`npm run bench` runs the pure algorithm functions under Node and reports elapsed time, throughput, heap delta, runtime version, OS, CPU model, and iteration count. Fixed-window and token-bucket loops reuse state. The sliding-window loop measures the exact event-log evaluator with a bounded event list. This isolates algorithm work and does not include Worker RPC, SQLite, Durable Object queueing, alarms, or network latency.

`npm run bench:do` runs a Worker-to-Durable-Object benchmark inside the Cloudflare Workers Vitest runtime. It reports request throughput, p50/p95/p99 latency, and database size change for 64, 256, and 1,024 active independent identities, plus 256 concurrent requests for one hot identity. These measurements include local Worker and Durable Object runtime overhead, but they are not Cloudflare production measurements and do not include internet routing. Storage operation billing is not exposed by the local harness, so the benchmark does not claim billed operations per decision.

Run each benchmark on an otherwise idle machine, record the commit and Node version with the output, and compare only runs on the same machine and setup. No benchmark numbers are committed as universal performance claims.
