/**
 * Enough ELF header to tell "this binary will run there" from "this binary
 * will not".
 *
 * Deploying an aarch64 build to an x86-64 fleet fails as `exec format error`
 * inside the agent, one viewer at a time, several seconds into a run — which
 * reads as a viewer problem. Four bytes of magic and one field of `e_machine`
 * turn that into a refusal before anything is uploaded.
 */

import { open } from 'node:fs/promises';

export interface BinaryTarget {
  /** `x86-64`, `aarch64`, or `elf-<number>` for anything we do not name. */
  machine: string;
  bits: 32 | 64;
  /** ELF osabi 0 (SysV, which Linux uses) vs anything else. */
  sysv: boolean;
}

const E_MACHINE = new Map<number, string>([
  [0x03, 'x86'],
  [0x28, 'arm'],
  [0x3e, 'x86-64'],
  [0xb7, 'aarch64'],
  [0xf3, 'riscv'],
]);

/** Undefined for anything that is not an ELF file at all — a Mach-O, a script. */
export async function readBinaryTarget(file: string): Promise<BinaryTarget | undefined> {
  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(20);
    const { bytesRead } = await handle.read(header, 0, 20, 0);
    if (bytesRead < 20) {
      return undefined;
    }
    if (header.readUInt32BE(0) !== 0x7f454c46) {
      return undefined;
    }
    const bits = header[4] === 2 ? 64 : 32;
    const littleEndian = header[5] === 1;
    const machine = littleEndian ? header.readUInt16LE(18) : header.readUInt16BE(18);
    return {
      machine: E_MACHINE.get(machine) ?? `elf-${machine}`,
      bits,
      sysv: header[7] === 0,
    };
  } finally {
    await handle.close();
  }
}

/** What `uname -s` / `uname -m` on the target would have to say for this to run. */
export function runsOn(binary: BinaryTarget, unameS: string, unameM: string): boolean {
  if (unameS.toLowerCase() !== 'linux') {
    return false;
  }
  const normalised = unameM === 'x86_64' || unameM === 'amd64' ? 'x86-64' : unameM;
  return binary.machine === normalised && binary.bits === 64;
}
