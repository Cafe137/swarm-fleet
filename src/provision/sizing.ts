/**
 * How big a box a viewer needs, and what renting it costs.
 *
 * Every constant here was fitted to one run — `runs/2026-09-09_17-21-15_cohort-200`,
 * 200 viewers at 128 peers on a 6-core box, watching a 2.83 Mbps stream — and
 * that run is worth reading before trusting them, because it failed. It asked
 * for 8.7 vCPU from six cores, pinned CPU at 97.3% for its whole measured
 * window and lost 95% of its viewers to stalling. What makes it a good source
 * for a cost model anyway is that it failed *predictably*: the box delivered
 * 42.4 MB/s at 0.138 core-seconds per MB, which is what the single-viewer
 * figure in `IMPROVEMENTS.md` (0.1268-0.1382) says one viewer costs. Nothing
 * was lost to running two hundred of them at once. The machine was simply
 * asked for more than it had.
 *
 * So the model is linear in media bytes, and the job of this file is to stop a
 * fleet being launched onto hardware that cannot hold it — which is the mistake
 * that run made, and which `schedule.ts` still cannot catch on its own (its
 * `steadyVcpu` is a flat 0.03, and under `--settle` it learns the cost of a
 * viewer parked at the barrier rather than one that is watching).
 */

import type { VultrPlan } from './vultr.js';
import { VULTR_BILLING_HOURS_PER_MONTH, VULTR_OVERAGE_USD_PER_GB } from './vultr.js';

/**
 * What one viewer costs, measured.
 *
 * `vcpuPerMediaMB` is the marginal figure: total cost per MB with the idle
 * peering baseline subtracted, so the two terms do not double-count.
 */
export const VIEWER_COST = {
  /** Holding 128 peer connections, watching nothing. 200 viewers cost 28.2% of 6 cores. */
  peerVcpu: 0.0085,
  /** Marginal retrieval, core-seconds per MB of media. */
  vcpuPerMediaMB: 0.098,
  /** RSS per viewer process: 7637 MB of tracked RSS across 200. */
  rssBytes: 38 * 1024 ** 2,
  /** Interface rx over media delivered, in the measured window. */
  wireToMedia: 1.35,
  /**
   * Egress as a share of media, and the softest number here.
   *
   * The run sent 0.6 Mbps per viewer against 2.83 Mbps of media, and nothing
   * establishes which of the two it tracks: it is far too large to be
   * retrieval requests (256 per MB at ~100 bytes is 0.05 Mbps) and is probably
   * peer chatter across 128 connections, which would make it constant rather
   * than proportional. Modelled as proportional because that is the
   * pessimistic reading for the bitrates a fleet actually runs. It is also
   * 100% of the bandwidth bill, so it is worth profiling properly.
   */
  txShareOfMedia: 0.21,
} as const;

/** Matches `DEFAULT_ADMISSION.targetUtilisation`: the same headroom, one number. */
export const TARGET_UTILISATION = 0.7;

export interface FleetRequirement {
  viewers: number;
  peers: number;
  /** Media bitrate one viewer consumes. */
  mediaMbps: number;
}

export interface FleetDemand {
  vcpu: number;
  /** vCPU with `TARGET_UTILISATION` headroom — what a box must actually have. */
  cores: number;
  memBytes: number;
  sockets: number;
  rxMbps: number;
  txMbps: number;
  egressGbPerHour: number;
}

export function viewerVcpu(mediaMbps: number): number {
  return VIEWER_COST.peerVcpu + (mediaMbps / 8) * VIEWER_COST.vcpuPerMediaMB;
}

/** What one machine must provide to hold `viewers` of them. */
export function demandFor(requirement: FleetRequirement): FleetDemand {
  const { viewers, peers, mediaMbps } = requirement;
  const vcpu = viewers * viewerVcpu(mediaMbps);
  const txMbps = viewers * mediaMbps * VIEWER_COST.txShareOfMedia;
  return {
    vcpu,
    cores: vcpu / TARGET_UTILISATION,
    memBytes: viewers * VIEWER_COST.rssBytes,
    sockets: viewers * peers,
    rxMbps: viewers * mediaMbps * VIEWER_COST.wireToMedia,
    txMbps,
    egressGbPerHour: (txMbps * 3600) / 8 / 1000,
  };
}

/**
 * Viewers a plan can hold, by the binding constraint.
 *
 * Ports are counted against the range this rig's cloud-init sets rather than
 * the Debian default, because a provisioned box gets that setting before it
 * ever holds a viewer.
 */
export const PROVISIONED_EPHEMERAL_PORTS = 55_296;

export interface PlanCapacity {
  viewers: number;
  binding: 'cpu' | 'memory' | 'ports';
}

export function capacityOf(
  plan: VultrPlan,
  peers: number,
  mediaMbps: number,
): PlanCapacity {
  const byCpu = Math.floor((plan.vcpu_count * TARGET_UTILISATION) / viewerVcpu(mediaMbps));
  // Leave a gigabyte for the OS and the agent, which peaked at 119 MB.
  const usableBytes = Math.max(0, plan.ram * 1024 ** 2 - 1024 ** 3);
  const byMemory = Math.floor(usableBytes / VIEWER_COST.rssBytes);
  const byPorts = Math.floor(PROVISIONED_EPHEMERAL_PORTS / Math.max(1, peers));

  const viewers = Math.min(byCpu, byMemory, byPorts);
  const binding = viewers === byCpu ? 'cpu' : viewers === byMemory ? 'memory' : 'ports';
  return { viewers, binding };
}

/**
 * `voc` is Optimized Cloud Compute, the only family with dedicated vCPU.
 *
 * The API does not say so — every plan reports `vcpu_type: "thread"` — so the
 * family prefix is the only signal, and it matters more here than price. On a
 * shared vCPU there is no way to separate the viewer's work from a neighbour's
 * contention, and a rig whose headline number is core-seconds per MB cannot
 * afford that ambiguity. The cheaper shared families are honest choices for a
 * capacity run; they are not for a measurement anyone will quote.
 */
export function isDedicated(plan: VultrPlan): boolean {
  return plan.type === 'voc';
}

export interface PlanChoice {
  plan: VultrPlan;
  capacity: PlanCapacity;
  /** Instances needed to hold the whole fleet. */
  instances: number;
}

export interface PlanFilter {
  viewersPerBox: number;
  peers: number;
  mediaMbps: number;
  /** Only Optimized (dedicated-vCPU) plans. */
  dedicatedOnly?: boolean | undefined;
  /** Skip plans not offered in every one of these regions. */
  regions?: readonly string[] | undefined;
}

/**
 * The cheapest plan that can hold `viewersPerBox`, or nothing if none can.
 *
 * Cheapest by hourly cost, since a rented load generator lives for a run and
 * the monthly price is never paid.
 */
export function choosePlan(plans: readonly VultrPlan[], filter: PlanFilter): PlanChoice | undefined {
  const viable = plans
    .filter((plan) => filter.dedicatedOnly !== true || isDedicated(plan))
    .filter((plan) =>
      filter.regions === undefined
        ? true
        : filter.regions.every((region) => plan.locations.includes(region)),
    )
    .map((plan) => ({
      plan,
      capacity: capacityOf(plan, filter.peers, filter.mediaMbps),
      instances: 1,
    }))
    .filter((choice) => choice.capacity.viewers >= filter.viewersPerBox)
    .sort((a, b) => a.plan.hourly_cost - b.plan.hourly_cost || a.plan.id.localeCompare(b.plan.id));

  return viable[0];
}

export interface CostEstimate {
  instanceUsd: number;
  /** Transfer beyond the hourly accrual, at the flat overage rate. */
  egressUsd: number;
  totalUsd: number;
  /** Transfer the plans accrue over the same hours. */
  includedGb: number;
  egressGb: number;
}

/**
 * What a run costs, including the transfer allowance a short-lived box does
 * *not* get.
 *
 * Vultr accrues a plan's monthly `bandwidth` hourly and never reconciles, so a
 * box that lives one hour earns 1/672nd of it. The multi-terabyte allowance on
 * the pricing page is close to irrelevant to a rig that rents by the hour, and
 * a cost estimate that quoted it would be wrong by an order of magnitude.
 */
export function estimateCost(
  plan: VultrPlan,
  instances: number,
  hours: number,
  egressGbPerHourPerInstance: number,
): CostEstimate {
  const instanceUsd = plan.hourly_cost * instances * hours;
  const includedGb = (plan.bandwidth / VULTR_BILLING_HOURS_PER_MONTH) * instances * hours;
  const egressGb = egressGbPerHourPerInstance * instances * hours;
  const egressUsd = Math.max(0, egressGb - includedGb) * VULTR_OVERAGE_USD_PER_GB;
  return {
    instanceUsd,
    egressUsd,
    totalUsd: instanceUsd + egressUsd,
    includedGb,
    egressGb,
  };
}

/** Round-robin over regions, so a fleet is not one datacentre's view of Swarm. */
export function spreadRegions(count: number, regions: readonly string[]): string[] {
  if (regions.length === 0) {
    throw new Error('no regions to spread across');
  }
  return Array.from({ length: count }, (_, at) => regions[at % regions.length] as string);
}
