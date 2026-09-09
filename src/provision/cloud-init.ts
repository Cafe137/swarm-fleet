/**
 * What a fresh box needs before it can hold viewers.
 *
 * `deploy` already ships the viewer and the agent, so this script exists for
 * the three things deploy cannot do over an ssh session — and for one thing
 * that would quietly corrupt a run.
 *
 * **Node.** `README` promises a remote machine needs nothing but an ssh key and
 * Node 20+. A stock Debian image has neither the version nor, reliably, the
 * runtime at all. It arrives as a pinned tarball from nodejs.org rather than
 * from apt, because a rig that cannot say which Node its agents ran is a rig
 * whose runs are not comparable, and `NODE_VERSION` is a one-line bump.
 *
 * **Ephemeral ports.** Debian gives 32768-60999, which is 28,232 outbound
 * sockets and therefore ~220 viewers at 128 peers. `CLAUDE.md` calls the port
 * range the first ceiling a machine hits and notes it is `sysctl`-tunable
 * toward 64k; this is that tuning, done before the ceiling can be mistaken for
 * a finding about Swarm. It is the one network setting touched, because it
 * removes an artificial limit on the *generator* rather than changing how the
 * viewer behaves.
 *
 * **Descriptor limits.** The agent raises its own soft limit to the hard limit
 * before exec'ing, which needs no privilege — but only up to whatever the hard
 * limit is. This raises the hard limit too.
 *
 * **Unattended upgrades, off.** This is the one that matters for the
 * measurement rather than for capacity. Debian's cloud image runs apt on a
 * timer; an unattended upgrade firing mid-run costs CPU on a box whose whole
 * purpose is to report how much CPU viewers cost, and `cpu_headroom` would
 * blame the fleet. A rented box that lives for an hour has nothing to patch.
 *
 * The script ends by writing a sentinel. Readiness means "this file exists",
 * not "sshd answered" — cloud-init is still running when sshd comes up, and a
 * deploy that races it lands on a box with no Node.
 */

/** Pinned, so every agent in every run is the same runtime. Bump deliberately. */
export const NODE_VERSION = 'v24.21.0';

export const READY_DIR = '/var/lib/swarm-fleet';
export const READY_SENTINEL = `${READY_DIR}/ready`;
export const FAILED_SENTINEL = `${READY_DIR}/failed`;

/**
 * Ephemeral port range for a provisioned box: 55,296 ports.
 *
 * Not 1024: leaving the low ports alone keeps the range clear of anything that
 * binds a fixed port, sshd included, at the cost of 9k ports nobody needs.
 */
export const PORT_RANGE = '10240 65535';

export interface CloudInitOptions {
  nodeVersion?: string | undefined;
  portRange?: string | undefined;
}

export function cloudInitScript(options: CloudInitOptions = {}): string {
  const node = options.nodeVersion ?? NODE_VERSION;
  const ports = options.portRange ?? PORT_RANGE;
  const tarball = `node-${node}-linux-x64.tar.xz`;

  // Plain shell rather than cloud-config YAML: Vultr hands user_data to
  // cloud-init, which runs a `#!`-led script as root, and a script can report
  // its own failure into a sentinel. A YAML `runcmd` failing is invisible.
  return `#!/bin/sh
set -eu

mkdir -p ${READY_DIR}
# Any exit before the sentinel is written leaves the reason where the readiness
# poll can read it, so a broken box fails the fleet in seconds instead of
# timing out at ten minutes with nothing to show.
trap 'echo "cloud-init failed at line $LINENO" > ${FAILED_SENTINEL}' EXIT

# --- keep apt off the CPU for the life of the box ------------------------
systemctl stop unattended-upgrades apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
systemctl disable unattended-upgrades apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
systemctl mask apt-daily.service apt-daily-upgrade.service 2>/dev/null || true

# --- limits ---------------------------------------------------------------
cat > /etc/sysctl.d/99-swarm-fleet.conf <<'SYSCTL'
net.ipv4.ip_local_port_range = ${ports}
fs.file-max = 2097152
SYSCTL
sysctl -p /etc/sysctl.d/99-swarm-fleet.conf >/dev/null

cat > /etc/security/limits.d/99-swarm-fleet.conf <<'LIMITS'
* soft nofile 1048576
* hard nofile 1048576
root soft nofile 1048576
root hard nofile 1048576
LIMITS

# sshd sessions inherit from systemd, not from limits.conf, so both are needed.
mkdir -p /etc/systemd/system.conf.d
cat > /etc/systemd/system.conf.d/99-swarm-fleet.conf <<'SYSTEMD'
[Manager]
DefaultLimitNOFILE=1048576:1048576
SYSTEMD
systemctl daemon-reexec 2>/dev/null || true

# --- node -----------------------------------------------------------------
if ! command -v curl >/dev/null 2>&1 || ! command -v xz >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl xz-utils
fi

cd /tmp
curl -fsSLO "https://nodejs.org/dist/${node}/${tarball}"
curl -fsSLO "https://nodejs.org/dist/${node}/SHASUMS256.txt"
# The tarball is fetched over plain HTTPS from a host we do not control; the
# checksum makes a truncated or swapped download fail here rather than as a
# confusing agent crash twenty minutes into a run.
grep " ${tarball}$" SHASUMS256.txt | sha256sum -c -
tar -xJf "${tarball}" -C /usr/local --strip-components=1
rm -f "${tarball}" SHASUMS256.txt

# --- done -----------------------------------------------------------------
trap - EXIT
node --version > ${READY_SENTINEL}
`;
}
