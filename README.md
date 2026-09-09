# swarm-fleet

Publishes a live stream over Swarm, launches many `weeb-3-rs-hls` viewers — across
machines — and turns what they report into KPIs about how Swarm behaves under viewer
load. Stalling first, and a dozen other things that turn out to matter.

One project, four commands: `publish` a stream, `deploy` the viewer, `run` the fleet,
`report` on it.

The viewer is [`weeb-3-rs-hls`](https://github.com/Cafe137/weeb-3-rs-hls) — a native Swarm
client that peers and watches a stream, and does nothing else. `--from-github` fetches the
Linux build its CI publishes, so a fleet needs no Rust toolchain and no binary copied by
hand; every example below uses it.

```sh
cd fleet
npm install

# does this machine have the headroom for 80 viewers at 200 peers?
npx tsx src/cli.ts doctor --viewers 80 --peers 200

# publish a stream, put the viewer on three boxes, and watch it from all of them
npx tsx src/cli.ts run --mode cohort --viewers 60 --duration 300 \
  --agent box-a --agent box-b --agent box-c --from-github \
  --publish --publish-duration 360

# 20 viewers on a stream someone else is publishing
npx tsx src/cli.ts run --mode cohort --viewers 20 --duration 300 \
  --agent box-a --from-github \
  --stream 6F2728386F8a47ef5EBe323721188e630Ff0FdE9:f3ee0319-469e-4c2c-bb83-edcb06deda33

# how many viewers before it breaks?
npx tsx src/cli.ts run --mode ramp --ramp-start 10 --ramp-step 10 --ramp-max 200 \
  --ramp-interval 120 --agent box-a --from-github --stream <owner>:<topic>
```

Exit codes: **0** the run is valid, **4** the run is *invalid* — a guard KPI breached, so
the numbers describe the load generator rather than Swarm — **1** it failed to start,
**2** bad usage.

## Develop against the mock, not against mainnet

`--binary mock` runs a built-in fake viewer that speaks the same contract, paces itself
against a clock that can be sped up, and injects the failures a real viewer produces. It
is how everything except the Swarm client itself is tested on every `npm test`.

```sh
npx tsx src/cli.ts run --mode cohort --viewers 6 --binary mock --segments 20 \
  --stream aa:bb --env MOCK_SPEED=20 --runs-dir /tmp/fleet-runs
```

| Env | | |
| --- | --- | --- |
| `MOCK_SPEED` | 1 | compresses wall time; 20 makes a 100 s run take 5 s |
| `MOCK_STALL_BIAS` | 1 | multiplies fetch time; above ~4 the buffer drains and it stalls |
| `MOCK_BODY_FAILURE_RATE` | 0.03 | the measured 2-5% of segments not retrievable at once |
| `MOCK_SKIP_RATE` | 0 | chance of falling off the live window |
| `MOCK_JOIN_FAIL_RATE` | 0 | chance of failing to join at all |
| `MOCK_CRASH_AFTER_MS` | 0 | injected crash |
| `MOCK_IGNORE_SIGTERM` | — | set to `1` to test the SIGKILL backstop |
| `MOCK_FETCH_MS`, `MOCK_FETCH_JITTER`, `MOCK_SEGMENT_BYTES`, `MOCK_PEERS`, `MOCK_RUNWAY_SECONDS` | | shape of the fake workload |

## Scenarios

| Mode | Shape | Answers |
| --- | --- | --- |
| `cohort` | N viewers, staggered, bounded by `--duration` or `--segments` | "What does 200 viewers look like?" |
| `ramp` | `--ramp-start`, `+--ramp-step` every `--ramp-interval`, to `--ramp-max` | **"How many viewers before Swarm breaks?"** |
| `soak` | fixed N, long duration | drift: leaks, peer churn, buffer decay |
| `flood` | N at once, no stagger. Needs `--acknowledge-flood` | join storms. Marked **not comparable** |
| `port-ceiling` | one machine, ramp until dials fail | "how many viewers before a box runs out of ports?" |

### `--verify` / `--unsafe`: what a viewer costs, versus what it costs honestly

Viewers do **not** verify retrieved chunk content by default (`--unsafe`), because the BMT over
each 4 KB chunk is 8.3% of a viewer's CPU — measured on 6-core x86 over 8 interleaved pairs,
0.1268 against 0.1382 CPU-seconds per MB. On a box where CPU binds before bandwidth, that is
~10 more viewers.

It is a real trade and every run records it. `--unsafe` runs carry a standing caveat, because:

-   viewer CPU is then ~8% below what a real browser client pays, so density figures are
    optimistic by about that much;
-   a peer answering with well-formed *wrong* bytes is believed. Absence still retries — a peer
    without the chunk replies empty and the length check catches that — but corruption would
    show up as a decode error rather than as a body failure in the KPIs.

Feed updates are authenticated either way, so the playlist is always the stream owner's. Pass
`--verify` when the question is what a real viewer costs rather than how many fit.

### `--settle`: peer the cohort before it watches

```sh
npx tsx src/cli.ts run --viewers 50 --duration 300 --settle --agent box-a --publish
```

Without it a cohort's ramp is inside its own measurement. Admission control admits a viewer
only while the box has CPU left for another join, so a large cohort takes a minute or more to
be fully up — during which viewers that are already retrieving share a thread with viewers
still verifying certificate chains, and the reported throughput is divided by a window that
contains the ramp.

`--settle` splits the run in two:

1.  Every viewer starts, dials to its **full** peer limit (not the 25 peers it needs to begin),
    and parks at a barrier. The live view's `held` column counts them.
2.  Once they are all there, the stream starts — a `--publish` run does not launch ffmpeg until
    this moment — and the barrier opens on every viewer at once.

The report then carries the settle phase and the measured window separately, and every rate is
over the measured window alone. A cohort that could not settle inside `--settle-timeout`
(default 300 s) is released anyway and the shortfall is recorded as a caveat, because 49 of 50
viewers peered is still worth measuring as long as nobody reads it as a clean cohort.

| | |
| --- | --- |
| `--settle-peers <n>` | peers to hold before release. Defaults to `--peers` |
| `--settle-timeout <s>` | release anyway after this long |
| `--no-settle` | the default: viewers watch as they come up |

It is refused with `--mode ramp`, which deliberately starts viewers during the measurement, so
there is no moment at which the cohort is complete. **Unsettled is a flash-crowd test; settled
is a steady-state capacity test** — see `IMPROVEMENTS.md` for what each one is and is not
measuring.

A ramp stops when a KPI breach *holds* for `--hold` seconds — `--stop-degraded` (default
0.10) or `--stop-join` (default 0.95). One slow segment across 200 viewers is weather, not
a cliff.

Anything not expressible in flags goes in a scenario file:

```sh
npx tsx src/cli.ts run --scenario my-run.json      # flags override the file
```

```json
{
  "mode": "ramp",
  "label": "three-streams-to-200",
  "binary": "/opt/swarm-fleet/weeb-3-rs-hls",
  "streams": [
    { "owner": "6F27…", "topic": "f3ee0319-…" },
    { "owner": "352e…", "topic": "0b1c2d3e-…" }
  ],
  "assignment": "round-robin",
  "peerLimit": 200,
  "ramp": { "start": 20, "step": 20, "intervalS": 120, "max": 400 },
  "stop": { "degradedFraction": 0.1, "joinSuccessRate": 0.95, "holdS": 30 },
  "agents": [
    { "host": "box-a", "user": "swarm-fleet", "weight": 2 },
    { "host": "box-b", "user": "swarm-fleet", "weight": 1 }
  ]
}
```

## The stream

`publish` puts a live HLS stream on Swarm in the format the viewer reads: ffmpeg segments
in, one feed update per manifest out, `#EXT-X-ENDLIST` when it stops. It needs `ffmpeg` on
`PATH` and nothing else — uploads go through a gateway that supplies its own postage.

```sh
npx tsx src/cli.ts publish --duration 300           # prints the watch command
npx tsx src/cli.ts publish --source clip.mp4 --segment-duration 2 --window 10
```

Or let the run own it, with `--publish`. The controller starts the publisher, **waits
until the playlist carries enough runway for a viewer to join the live edge**, points the
fleet at it, and finalizes it as VOD when the run ends. That wait is not politeness: a
viewer cannot join a live edge until 8 s of contiguous segments sit behind it
(`HLS_LIVE_STARTUP_BUFFER_SECONDS`), and viewers launched sooner all sit in `join` for up
to 30 s and then report a join latency that describes the publisher.

```sh
npx tsx src/cli.ts run --viewers 20 --duration 300 --agent box-a \
  --publish --publish-bitrate 2600k --publish-segment-duration 2
```

**Encoding video costs several cores** — 4.2 of 8 measured at 1120x700 and 30fps — and it
lands on whichever machine the controller runs on. So publish from a machine that hosts no
viewers. A run that does both is caveated in the report and will be refused by preflight's
idle check unless forced, which is the correct outcome rather than an inconvenience.

## Many machines

`--agent <host>` (repeatable) runs agents over SSH stdio: no ports to open, no listener to
authenticate, existing keys are the whole auth story.

```sh
npx tsx src/cli.ts run --mode ramp --agent box-a --agent box-b --agent box-c ...
```

**`--deploy` gets the code there.** The viewer binary and the agent are both
content-addressed by their sha256 and pushed under `/tmp/swarm-fleet`, so one `--binary`
path is correct on every machine including the controller's own, a host that already has
the right bytes is skipped, and preflight's insistence that every agent report the same
sha256 becomes a check that the deploy worked rather than a check that a human copied
files consistently.

```sh
# get the machines ready and run nothing: the step that fails for boring reasons
npx tsx src/cli.ts deploy --agent box-a --agent box-b --from-github

# or do it as part of the run
npx tsx src/cli.ts run --from-github --agent box-a --agent box-b

# a locally built viewer instead of CI's — only ever from a Linux controller
npx tsx src/cli.ts run --deploy --binary ../weeb-3-rs-hls/target/release/weeb-3-rs-hls --agent box-a
```

**`--from-github` takes the viewer from CI** rather than from a laptop — which is the only
option that can work, since a locally built Mach-O cannot execute on a Linux box. It
verifies the `.sha256` published beside the binary and records the commit in `deploy.json`.
It reads `Cafe137/weeb-3-rs-hls` unless `--github-repo <owner>/<name>` says otherwise.
`--github-commit <sha>` pins a build and `--github-run <id>` takes an exact run; both read
a workflow artifact, which GitHub will not serve anonymously, so they need `gh` and a
`gh auth login`. Without `gh` it falls back to the newest **release**, which needs no token
at all — that is what the rolling `nightly` prerelease exists for, and `--github-tag
nightly` asks for it explicitly.

A remote host therefore needs **an ssh key and Node 20+**, and nothing else — no npm
install, no fleet checkout. The agent ships as a 0.5 MB tarball of compiled JS plus its
one dependency; deploy checks `uname`, refuses a binary built for the wrong architecture
before uploading it, and refuses a host whose Node is too old.

`weight` splits the fleet unevenly across unequal machines. `maxViewers` caps one host.
The controller should not host viewers in a real run — its own Node process lands in the
same CPU and memory budget as the viewers — so name every machine explicitly rather than
leaving the default `local` agent in place.

## While it runs

The live view redraws one block a second, in place: the fleet's KPIs, and then one
row per machine.

```
  elapsed 1:24/5:00  █████░░░░░░░░░░░░░  viewers 58/60  joined 56  bootstrapping 2

  ┌──────────┬───────────┬──────────────┬───────────┬──────────┬───────────┬────────┐
  │ degraded │ stall p95 │ realtime p95 │ media     │ segments │ retrieved │ guards │
  ├──────────┼───────────┼──────────────┼───────────┼──────────┼───────────┼────────┤
  │ 1.7%     │ 0.4%      │ 0.61         │ 47.3 Mbps │ 2914     │ 1839 MB   │ ok     │
  └──────────┴───────────┴──────────────┴───────────┴──────────┴───────────┴────────┘

  ┌───────┬─────────┬─────────┬───────┬───────┬───────┬────────────┬─────────┬──────────────────┐
  │ host  │ viewers │ booting │ cpu   │ load  │ mem   │ rx/tx Mbps │ sockets │ note             │
  ├───────┼─────────┼─────────┼───────┼───────┼───────┼────────────┼─────────┼──────────────────┤
  │ box-a │ 20/20   │ 0       │ 18.4% │ 2.1/8 │ 9.2%  │ 16.8/0.6   │ 4021    │                  │
  │ box-b │ 20/20   │ 0       │ 19.1% │ 2.3/8 │ 9.4%  │ 17.2/0.6   │ 4018    │                  │
  │ box-c │ 18/20   │ 2       │ 24.8% │ 3.9/8 │ 9.1%  │ 14.9/0.5   │ 3702    │ cpu budget spent │
  └───────┴─────────┴─────────┴───────┴───────┴───────┴────────────┴─────────┴──────────────────┘
```

`viewers` is running against target and `booting` is the subset of those that have not
reported a join yet — the number admission control is spending its CPU budget on. It is
a subset, not an addition: `20/20` with `booting 20` is a machine whose viewers are all
up and none of which has joined.

A fleet run fails at the machine level, and none of that is visible in a fleet-wide
average. The per-machine numbers are the ones the guards judge, so a run about to be
marked invalid looks wrong on screen first — the offending row says
`BREACHED cpu_headroom` where its admission note would be. A dash means "not measured",
never zero.

The block is sized to the terminal and never wraps: on a narrow one it gives up the
columns that explain a problem before the ones that show it, `sockets` first and
`degraded`, `realtime p95` and the guard verdict last. `--quiet` turns the block off;
without a TTY it degrades to one line every 10 s.

`rx/tx` is the machine's own interface counters, loopback excluded. It is the only
measurement of what the fleet actually costs the wire: `Mbps media` above it is built
from viewer-reported *media* bytes and cannot see Swarm's retrieval overhead.

## What comes out

```
runs/<run-id>/
  run.json                  resolved scenario, per-machine preflight, binary sha256,
                            weeb-3 git SHA, port range, ulimit -n, cores, clock offsets
  deploy.json               what was deployed where, with the commit it came from
  publisher.json            the stream this run made: owner, topic, segments, bytes
  machines/<agent>.ndjson   the resource series, one object per sample
  viewers/<id>.ndjson       raw viewer events, verbatim
  viewers/<id>.log          viewer stderr
  summary.json              every KPI, plus the validity verdict
  report.md                 the human read
```

`machines/<agent>.ndjson` is the series `summary.json` only keeps the peaks of. Peaks
compare runs; the series explains one — a 56% CPU spike lasting a second is invisible next
to a 1-minute load average of 0.82, and "was that real?" is only answerable afterwards
from the series. It is written as it arrives, so a run that dies still leaves it.

`report.md` closes with a per-machine table — peak load, peak CPU, peak viewer RSS, peak
rx/tx, bytes in, peak sockets — and the **wire-to-media ratio**: interface bytes over
media bytes delivered. Above 1 the surplus is Swarm's retrieval overhead, and it is a
number nothing else here can produce.

`swarm-fleet report <run-dir>` re-renders `report.md` from `summary.json`, so a
change to the reporting does not need the run repeated.

The headline is **`degradedFraction`** — the share of viewers that lost more than 1% of
media time to stalling. Not a mean: one viewer's p99 is noise, and a mean stall ratio
across 200 viewers hides the twenty that could not watch. The leading indicator is
**`realtimeFactor`** (`fetch_ms / segment_ms`); above 1 a viewer is losing buffer and will
stall later, so that curve moves first.

## Guard KPIs, and why a run can be marked invalid

A load rig's one fatal failure is reporting the generator's limits as the network's. So
every run also judges the rig: CPU and memory headroom, dial failures, stagger adherence,
sampler lateness, clock skew. A breach makes the run **invalid** — the numbers are still
written out, flagged, and exit code 4 — rather than being quietly averaged in.

Crashed viewers invalidate a run too, above 5% of those started: a fleet that lost
viewers was measuring a smaller fleet than it reports.

## Things worth knowing

-   **One process per viewer, always.** The decoded-chunk cache is a `thread_local!` and
    chunks are content-addressed, so viewers sharing a process would serve each other out
    of local memory and the rig would under-report retrieval traffic by exactly the amount
    it exists to measure.
-   **Stagger is admission control, not a delay.** Each agent admits a viewer only while
    `bootstrapping x 0.18 + running x 0.03 < cores x 0.7` vCPU, seeded from
    measurements on an M1 and replaced by measured cost once the run has samples. A jittered
    250 ms floor survives alongside it, for the bootnodes' sake. Ramping 200 viewers
    therefore takes a couple of minutes, and that is the honest cost of a measurable ramp.
-   **`ulimit -n` breaks a Linux fleet before anything else does.** One viewer holds 200
    peer connections; the usual 1024 soft limit is enough for four, and the failure looks
    like a network problem. Preflight refuses the run.
-   **Many viewers on one stream is a popularity test, not a capacity test.** Swarm's
    forwarding nodes cache what passes through them, so 1,000 viewers of one stream place
    nowhere near 1,000x the load on storers that 1,000 distinct streams would. The report
    says which regime a run was in; use several `--stream` flags and
    `--assignment round-robin` to separate them.
-   **`--peers` is the density lever, and lowering it lowers what is measured.** 200 is
    the real browser client's footprint and stays the default.
-   **`--dial-rate` is how many connections a second each viewer may open.** The viewer
    defaults to 50/s and that is usually right; drop it to 25 when a box is packed. It
    matters because the join is the only expensive part of a viewer's life — each
    connection costs ~2.6 ms verifying a `/tls/ws` certificate chain, on the one thread
    the viewer has — and `--dial-rate 0` restores the unpaced burst, which pins a core per
    joining viewer and *invalidated a 25-viewer run on 8 cores*: peak load 3.75 against
    1.55, join p95 13.4 s against 6.4 s, 596 dial failures against 146.
-   **The wire-to-media ratio is an upper bound on a shared machine.** Interface counters
    see everything on the NIC, so a box that also ran the publisher, the controller or
    someone's backup reports their traffic as the fleet's. Dedicated machines make it a
    measurement; anything else makes it a ceiling.
-   **`machine_idle` is fatal for a real run and advisory for `--binary mock`.** A mock's
    numbers are synthetic, so there is no measurement left to protect and refusing would
    only stop the rig's own tests from running on a working laptop. For a real binary the
    check stands: a stall caused by someone's build is indistinguishable in the output
    from a stall caused by Swarm.
-   **`npm test` runs test files one at a time** (`--test-concurrency=1`). The integration
    tests spawn real viewer processes and run a real preflight, so files in parallel would
    load the machine enough to make a genuine refusal look like flakiness.
-   **Do not make the runner smooth over viewer behaviour.** If a viewer's retries look
    expensive, that is the measurement. A supervisor that restarted stalled viewers,
    capped their retries or shared a cache between them would be repeating, with more
    moving parts, the mistake the viewer itself made twice: an invented deadline that
    measured the instrument instead of the network.
