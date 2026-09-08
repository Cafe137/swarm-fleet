/** Flag parsing. Small on purpose; the publisher's CLI does the same. */

export { defined } from './util.js';

export class Args {
  constructor(private readonly argv: readonly string[]) {}

  get positional(): string[] {
    const out: string[] = [];
    for (let at = 0; at < this.argv.length; at += 1) {
      const token = this.argv[at] as string;
      if (token.startsWith('--')) {
        // Boolean flags take no value; everything else consumes the next token.
        if (!BOOLEAN_FLAGS.has(token) && this.argv[at + 1] !== undefined) {
          at += 1;
        }
        continue;
      }
      out.push(token);
    }
    return out;
  }

  has(name: string): boolean {
    return this.argv.includes(`--${name}`);
  }

  value(name: string): string | undefined {
    const at = this.argv.lastIndexOf(`--${name}`);
    return at === -1 ? undefined : this.argv[at + 1];
  }

  /** Every occurrence, so `--stream a --stream b` both arrive. */
  values(name: string): string[] {
    const out: string[] = [];
    this.argv.forEach((token, at) => {
      if (token === `--${name}`) {
        const value = this.argv[at + 1];
        if (value !== undefined) {
          out.push(value);
        }
      }
    });
    return out;
  }

  number(name: string): number | undefined {
    const raw = this.value(name);
    if (raw === undefined) {
      return undefined;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      throw new Error(`--${name} expects a number, got ${raw}`);
    }
    return parsed;
  }
}

export const BOOLEAN_FLAGS = new Set([
  '--live',
  '--vod',
  '--deploy',
  '--from-github',
  '--publish',
  '--force',
  '--acknowledge-flood',
  '--count-sockets',
  '--json',
  '--stdio',
  '--quiet',
]);
