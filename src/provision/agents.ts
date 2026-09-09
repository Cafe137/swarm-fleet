/**
 * Where a run's machines come from.
 *
 * Split out of `cli.ts` so it can be tested: the bug that made it necessary was
 * not in any of the pieces but in the wiring between them.
 */

import type { Args } from '../args.js';
import { AgentTarget } from '../scenario.js';
import { DEFAULT_STATE_DIR, agentTargetsFor, readFleetState } from './provision.js';

/**
 * Where a run's machines come from.
 *
 * `--fleet <id>` reads what `provision` recorded, which is more than a list of
 * addresses: it carries the ssh user and marks each host **ephemeral**, so the
 * connection skips `known_hosts`. That matters rather than being tidy — a box
 * created ten minutes ago is not in anyone's `known_hosts`, and `BatchMode=yes`
 * turns first contact into `Host key verification failed` rather than a prompt.
 * Passing the same machines as bare `--agent root@ip` strings loses that and
 * the deploy dies before it uploads anything.
 *
 * Both forms are accepted and combine, so a rented fleet and a permanent box
 * can be in one run.
 */
export async function agentsFromArgs(args: Args): Promise<AgentTarget[]> {
  const named = args.values('agent').map((host) => AgentTarget.parse({ host }));
  const fleetId = args.value('fleet');
  if (fleetId === undefined) {
    return named;
  }
  const stateDir = args.value('state-dir') ?? DEFAULT_STATE_DIR;
  const fleet = await readFleetState(stateDir, fleetId);
  if (fleet === undefined) {
    throw new Error(`no record of fleet ${fleetId} under ${stateDir}/`);
  }
  if (fleet.instances.length === 0) {
    throw new Error(`fleet ${fleetId} has no instances — already destroyed?`);
  }
  return [...agentTargetsFor(fleet), ...named];
}
