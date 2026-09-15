# swarm-fleet

Publishes a live stream over Swarm, launches many `weeb-3-rs-hls` viewers — across
machines — and turns what they report into KPIs about how Swarm behaves under viewer
load. Stalling first, and a dozen other things that turn out to matter.

One project, five commands: `publish` a stream, `deploy` the viewer, `run` the fleet,
`report` on it — and `join`, which drives viewers from an operator's own machine by hand
rather than from a scripted plan.

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

## `join`: hand-driven viewers, from wherever they are

Everything above rents machines and produces a defensible capacity number. `join` answers a
different question: what Swarm does when the load comes from ordinary machines on ordinary
connections, behind the NATs and routers a rented fleet never sees. Each machine runs one
command and is scaled by hand; a backend tells them all what to watch and collects what they
report.

```sh
npx tsx src/cli.ts join --server https://loadtest.example.org
```

That is the whole command. It asks the backend what to watch, downloads the viewer built for
*this* machine, starts twenty of them, and draws a dashboard with two keys — right arrow adds
twenty, left arrow removes twenty, `q` stops. Every fifteen seconds it posts its node count
and throughput, and gets back the leaderboard it appears on.

A participant never types any of that. The backend
([`swarm-loadtest-backend`](https://github.com/Cafe137/swarm-loadtest-backend)) serves an
installer with its own address already in it, so what gets handed out is two lines: one that
installs (fetching a private Node if the machine has none) and writes a `swarm-loadtest`
launcher, and then the launcher itself.

```sh
curl -fsSL https://loadtest.example.org/join | sh    # install
swarm-loadtest                                       # run
```

**The split is load-bearing.** A script piped into `sh` has the pipe as its standard input,
and so does anything it starts — a client launched from inside the installer cannot read a
keystroke, so the arrow keys would do nothing while the dashboard advertised them. Run from
the prompt, it owns the terminal.

Four things behave differently under `join`, and all of them are deliberate:

-   **`--mode session`.** No duration, no ramp, no end: the target is whatever the arrow keys
    last said, viewers that end are replaced, and the session is over when the person says so.
    Replacement works off a start budget that *slides* with what has already been started, so
    an evening of scaling up and down, and viewers retiring after their hour, never runs it
    out — while a viewer that crashes on startup is still bounded to a few retries a minute.
-   **`--profile participant`.** Preflight becomes advisory. A machine somebody also uses for
    other things is never idle and will never pass a rig's headroom checks, and refusing to run
    there would cost the test viewers while protecting a measurement that was not going to be
    published as capacity. Every check still runs, and the report says which machine it was.
-   **About 80 nodes is the ceiling on any laptop**, and it is ephemeral ports rather than
    memory or CPU: 200 peers per node against the 16,384 ports the BSDs hand out. Measured
    limits on macOS 14 are `kern.maxfilesperproc` 61,440 and a shell soft limit of 1,048,576,
    so descriptors are not what runs out there. Lifting the port range needs `sudo`; the left
    arrow does not.
-   **The descriptor limit is raised first.** One viewer needs a little over 200 descriptors
    and a macOS terminal has historically offered 256 in total, so the process re-executes
    itself under a shell that raises the limit before anything else happens. Getting this wrong
    does not look like a limit; it looks like Swarm being broken.

Try it without Swarm using the mock viewer, against a backend running locally:

```sh
npx tsx src/cli.ts join --server http://127.0.0.1:8080 --binary mock
```

There is no participant token: the backend authenticates nobody, and is meant to sit on a
private network or behind a proxy. See its README.

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
| `MOCK_PEERS_EVICT_AFTER_MS`, `MOCK_PEERS_EVICT_TO` | `0` (off), `0.3` | drop to this share of the peer limit after this long, simulating a full NAT table — the only way to exercise `peer_target` end to end |

## Scenarios

| Mode | Shape | Answers |
| --- | --- | --- |
| `cohort` | N viewers, staggered, bounded by `--duration` or `--segments` | "What does 200 viewers look like?" |
| `ramp` | `--ramp-start`, `+--ramp-step` every `--ramp-interval`, to `--ramp-max` | **"How many viewers before Swarm breaks?"** |
| `soak` | fixed N, long duration | drift: leaks, peer churn, buffer decay |
| `flood` | N at once, no stagger. Needs `--acknowledge-flood` | join storms. Marked **not comparable** |
| `port-ceiling` | one machine, ramp until viewers stop getting their peers | "how many viewers before a box runs out of connections?" |

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
0.10), `--stop-join` (default 0.95) or `--stop-peers` (default 0.90). One slow segment across
200 viewers is weather, not a cliff.

`--stop-peers` is the **connection ceiling**, and it is the one that finds a NAT. A box behind
one holds a fixed total number of connections whatever you do, so the ceiling never announces
itself as a stall or a failed dial — it shows up as viewers quietly holding fewer peers than
they were told to, and a ramp that climbs past it is adding processes, not load. Stopping
there makes the last passing step the machine's real capacity, and the report's capacity curve
carries a `Peers held` column so the plateau is visible.

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

### A machine that drops out shrinks the fleet; it does not stall it

A control channel dies with the machine behind it — the agent is attached to that pipe and
kills its own viewers when it closes — so there is nothing to reconnect to. What recovery
means is stopping the *other* machines waiting for it:

-   the fleet's size, its per-agent targets and the `--settle` barrier are all recomputed over
    the machines that are still answering, so a cohort is released when the viewers that still
    exist are holding their peers;
-   the lost machine's viewers stop being counted as running. They are their own outcome,
    `agent_lost`, and are left out of the peer-attainment judgement, so an ssh failure is not
    reported as Swarm losing peers;
-   the run continues, is marked **invalid** naming the machine and the last line ssh wrote
    before the pipe closed, and carries a caveat saying how much of the fleet was left;
-   the survivors are **not** given the lost machine's share. They were sized and admitted for
    their own, and starting another fifty viewers on each mid-run would trade a fleet that is
    smaller than requested for one that is overloaded.

This was written after a 20-machine, 1000-viewer settled run lost two boxes during the join:
the other 900 viewers sat parked at the barrier, peered and watching nothing, until the run
was killed — because the barrier was still waiting for 100 viewers on machines that no longer
existed.

## Renting the machines

`provision` rents boxes from Vultr, installs what an agent needs, and hands back the
`--agent` flags to run against them. `destroy` gives them back. Both need
`VULTR_API_KEY` in the environment; sizing does not, so `--plans` and `--dry-run` work
before an account exists.

```sh
# what would this cost, and on what?
npx tsx src/cli.ts provision --count 5 --viewers-per-box 50 --bitrate 2 --dry-run

# rent them
export VULTR_API_KEY=...
npx tsx src/cli.ts provision --count 5 --viewers-per-box 50 --bitrate 2

# ... run against the --agent flags it printed ...

npx tsx src/cli.ts destroy --fleet 20260909-193045
```

**The plan is chosen from the measured cost of a viewer, not from a table.** A viewer
costs `0.0085 + media_MB_per_s x 0.098` vCPU — the peering baseline and the marginal
retrieval cost fitted to `runs/2026-09-09_17-21-15_cohort-200` — so `--viewers-per-box`
and `--bitrate` together pick the cheapest plan with 30% headroom, and `--plans` shows
the alternatives with the constraint that binds each one. That run is the reason this
exists: it asked 8.7 vCPU of a six-core box, pinned the CPU and lost 95% of its viewers,
and nothing in the rig had said no beforehand.

**Dedicated vCPU is the default.** Only Vultr's `voc` family has it, and the API will not
tell you — every plan reports `vcpu_type: "thread"`, so the family prefix is the only
signal. On a shared vCPU there is no way to separate the viewer's work from a neighbour's
contention, which makes core-seconds per MB unquotable. `--shared` allows the cheaper
families and the command says plainly what it costs you.

**Instances carry a tag, and teardown reads it from the provider.** `destroy --fleet <id>`
asks Vultr which instances carry that fleet's tag rather than trusting the record under
`provisioned/`, so a fleet survives a lost state file or a different laptop.
`destroy --list` shows everything this rig has ever created and `destroy --all` removes it.
A provisioning run that fails part-way destroys what it already created before reporting
the failure — eight boxes billing by the hour because the ninth was refused is the
expensive version of that mistake.

**Boxes get five minutes of setup they would not otherwise have.** cloud-init pins Node
(installed from nodejs.org and checksummed, so every agent in every run is one runtime),
widens the ephemeral port range from Debian's 28,232 to 55,296 — `CLAUDE.md` calls that
the first ceiling a machine hits — raises the descriptor limit, and **disables unattended
upgrades**, which is the one that matters for the measurement rather than for capacity:
apt firing mid-run spends CPU on the machine whose whole job is reporting how much CPU
viewers cost. Readiness means that script finished, not that sshd answered, because a
deploy racing cloud-init lands on a box with no Node.

**Transfer allowance is prorated hourly and never reconciled.** A plan's 6 TB/month is
6144/672 = 9.1 GB per hour an instance exists, and egress past that is $0.01/GB
immediately — so the headline allowance is close to irrelevant to a rig that rents by the
hour, and the cost estimate says what you will actually pay. Ingress is free, which is
lucky: the fleet's traffic runs about 4:1 inbound.

Regions round-robin across five locations by default. `--region <id>` (repeatable)
overrides that. A fleet in one datacentre shares an upstream and correlates its Kademlia
neighbourhoods, which measures something narrower than an audience.

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
every run also judges the rig: CPU and memory headroom, **peer footprint**,
stagger adherence, sampler lateness, clock skew. A breach makes the run **invalid** — the
numbers are still written out, flagged, and exit code 4 — rather than being quietly averaged
in.

Crashed viewers invalidate a run too, above 5% of those started: a fleet that lost
viewers was measuring a smaller fleet than it reports.

`peer_target` asks whether the viewers actually held the peers they were told to hold, and
it exists because nothing did. A rented box behind a NAT was measured holding **~16,000
connections in total however many viewers wanted them**: at 64 viewers x 200 peers every
viewer held all 200, at 80 viewers *none* of them did, and at 128 the fleet still held
~15,800 — the last viewers to start held 200 while the first were down to 1, because a full
NAT table evicts its oldest translation to make room for a new one. The generator produced
roughly half the connection load the run asked for, and **every existing guard passed**:
load was 3.27 of 122 cores and memory 196 GB free, and nothing else on the box could see
it. The stalls that followed would have been published as Swarm's.

It is judged on peers *held*, not peaks — an evicting NAT lets every viewer reach its target
before taking the connections back — and the two shapes are named apart, because they point
at different places to look: **evicted** (reached the target, then lost it) means something
between the fleet and the network is taking connections away; **starved** (never reached it)
means the peer limit, the dial rate, or a table that was already full. A viewer short of its
peers is not a degraded viewer but a *smaller* one, so this cannot be seen in
`degradedFraction`. In `port-ceiling` and `flood` the shortfall is the measurement rather
than a fault, so there it is recorded without voiding the run.

`clock_skew` is the one deliberately loose guard: it tolerates **a full second**. The
controller applies each agent's measured offset to two fields per viewer — its start and its
exit — and every judged number is either viewer-local (`degradedFraction`, `fetch_ms`,
`stall_s`, all measured inside one process against its own monotonic clock) or
controller-local (`aggregateMbps`). Sub-second drift cannot move a published figure, and a
tighter threshold twice failed runs for a controller laptop that had not synced NTP. Past a
second the clock is genuinely wrong and a multi-machine timeline really is smeared, so it
fires. The offset is still reported at any size — it is worth seeing even when it is nobody's
problem.

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
    1.55 and join p95 13.4 s against 6.4 s.
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
