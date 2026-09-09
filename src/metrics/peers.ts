/**
 * Did viewers actually hold the peer footprint they were told to hold?
 *
 * Nothing was watching this, and it turned out to be the one question that
 * separates "Swarm is slow" from "the load generator never generated the load".
 * A rented box behind a NAT was measured holding ~16,000 connections in total
 * no matter how many viewers wanted them: at 64 viewers x 200 peers every
 * viewer held its full 200, at 80 viewers *none* of them did, and at 128 the
 * fleet still held ~15,800 — the last viewers to start held 200 while the first
 * ones were down to 1, because a full NAT table evicts its oldest translation
 * to make room for a new one.
 *
 * The generator therefore produced roughly half the connection load the run
 * asked for, and every guard passed: load was 3.27 of 122 cores, memory 196 GB
 * free, and `dial_failures` could not see it because a viewer stuck at zero
 * peers never stops bootstrapping, so its settle gate never opened. The stalls
 * that followed would have been published as Swarm's.
 *
 * Two shapes matter and they point at different causes, so they are counted
 * apart rather than summed:
 *
 *   - **starved** — never reached the target. The viewer could not get its
 *     connections in the first place: peers refusing, or a table already full.
 *   - **evicted** — reached it, then lost it. Something took established
 *     connections away, which is the NAT signature above and is invisible in
 *     any peak-only figure.
 */

/** One viewer's peer story: what it was told to hold, and what it held. */
export interface PeerAttainment {
  /** `--peers`: the footprint this viewer was asked to acquire. */
  target: number;
  /** The highest peer count it ever reported. */
  peak: number;
  /** Its last reported peer count — for a clean exit, its `summary`. */
  last: number;
  /** How long it was alive. A viewer killed mid-join never had a chance. */
  lifetimeMs: number;
  /** A viewer that died on its own says nothing about peer capacity. */
  crashed: boolean;
}

/**
 * Share of its target a viewer must hold to count as having its footprint.
 *
 * Not 1.0, because peers churn and a viewer sitting at 199 of 200 is a healthy
 * viewer. Not lower, because the gap between working and broken turned out to
 * be enormous: healthy cohorts held the target exactly (32 of 32 and 64 of 64
 * viewers at 200 of 200), and the broken ones sat at 51-62% of it. Anything in
 * between separates them, so this is placed well clear of normal churn.
 */
export const PEER_ATTAINMENT_FRACTION = 0.9;

/**
 * How long to let a viewer that has *never* reached its target keep trying.
 *
 * A viewer reaches 200 peers in 5-15 s at the default 50/s dial rate, so this
 * is roughly twice the slowest join observed. It applies only to the viewer
 * that has not got there yet, which is the only case where a low count is
 * ambiguous — mid-join and starved look identical until the clock decides. A
 * viewer that already touched its target needs no allowance at all: it has
 * demonstrably had its chance, and the question has moved on to whether it kept
 * what it got.
 *
 * Scoping it this way is what lets the eviction case be seen the moment it
 * happens rather than 30 s later, which matters for the live ramp stop. It is
 * also what keeps the mock viewer able to exercise this at all: the mock
 * compresses time and exits in under 10 s, so a flat wall-clock gate would have
 * made the rig's own tests permanently blind here.
 */
export const PEER_JOIN_ALLOWANCE_MS = 30_000;

export interface PeerAttainmentSummary {
  /** Viewers old enough, and alive enough, to be judged. */
  judged: number;
  /** Viewers left out: too young to have joined, or crashed. */
  skipped: number;
  /** Judged viewers holding at least `PEER_ATTAINMENT_FRACTION` of target. */
  holding: number;
  /** Reached the target, then lost it. */
  evicted: number;
  /** Never reached the target at all. */
  starved: number;
  /** Peers actually held, summed over judged viewers. */
  peersHeld: number;
  /** Peers those viewers were told to hold. */
  peersWanted: number;
  /** Share of judged viewers *not* holding their footprint. Undefined if none. */
  shortfallFraction?: number | undefined;
  /** `peersHeld / peersWanted`. The fleet's share of the load it was asked for. */
  attainedFraction?: number | undefined;
}

/**
 * Fold per-viewer peer counts into one verdict-ready summary.
 *
 * Pure, and deliberately not given the run's mode or thresholds: what counts as
 * *too much* shortfall differs between a cohort (which wanted this load) and a
 * `port-ceiling` ramp (which is looking for exactly this cliff), so callers
 * decide that. This only answers what happened.
 */
export function summarisePeerAttainment(
  viewers: readonly PeerAttainment[],
): PeerAttainmentSummary {
  let judged = 0;
  let skipped = 0;
  let holding = 0;
  let evicted = 0;
  let starved = 0;
  let peersHeld = 0;
  let peersWanted = 0;

  for (const viewer of viewers) {
    const floor = viewer.target * PEER_ATTAINMENT_FRACTION;
    const reached = viewer.peak >= floor;
    // A viewer that never reached its target is only starved once it has had
    // time to; before that it is simply still dialing.
    const hadItsChance = reached || viewer.lifetimeMs >= PEER_JOIN_ALLOWANCE_MS;
    if (viewer.crashed || !hadItsChance) {
      skipped += 1;
      continue;
    }
    judged += 1;
    peersHeld += viewer.last;
    peersWanted += viewer.target;
    if (viewer.last >= floor) {
      holding += 1;
    } else if (reached) {
      evicted += 1;
    } else {
      starved += 1;
    }
  }

  return {
    judged,
    skipped,
    holding,
    evicted,
    starved,
    peersHeld,
    peersWanted,
    ...(judged === 0 ? {} : { shortfallFraction: (judged - holding) / judged }),
    ...(peersWanted === 0 ? {} : { attainedFraction: peersHeld / peersWanted }),
  };
}

/**
 * One line naming what went wrong, for a guard detail or a stop reason.
 *
 * Names the dominant shape rather than both, because the two point at different
 * places to look and a reader chasing a capacity number wants the pointer, not
 * a census.
 */
export function describePeerShortfall(summary: PeerAttainmentSummary): string {
  const { judged, holding, evicted, starved, peersHeld, peersWanted } = summary;
  const share = ((peersHeld / peersWanted) * 100).toFixed(0);
  const head =
    `${holding} of ${judged} viewers held their peer footprint ` +
    `(${peersHeld} of ${peersWanted} peers, ${share}%)`;
  if (evicted >= starved && evicted > 0) {
    return (
      `${head} — ${evicted} reached the target then lost it, which is connections ` +
      `being taken away rather than never granted: suspect a NAT or conntrack table ` +
      `between the fleet and the network, not Swarm`
    );
  }
  if (starved > 0) {
    return (
      `${head} — ${starved} never reached it at all: suspect the peer limit, the dial ` +
      `rate, or a connection table that was already full`
    );
  }
  return head;
}
