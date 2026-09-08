import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CpuMeter,
  parseCpuTime,
  parseNetstatInterfaces,
  parseProcNetDev,
  parsePsOutput,
  RateMeter,
} from './sampler.js';

test('cpu time parses the formats ps actually emits', () => {
  assert.equal(parseCpuTime('0:02.30'), 2.3);
  assert.equal(parseCpuTime('1:00.00'), 60);
  assert.equal(parseCpuTime('12:34'), 754);
  assert.equal(parseCpuTime('1:02:03'), 3723);
  assert.equal(parseCpuTime('2-01:00:00'), 2 * 86400 + 3600);
  assert.equal(parseCpuTime('  0:00.01  '), 0.01);
});

test('an unrecognised cpu time is missing data, not a guess', () => {
  assert.equal(parseCpuTime(''), undefined);
  assert.equal(parseCpuTime('nonsense'), undefined);
  assert.equal(parseCpuTime('1:2:3:4'), undefined);
});

test('ps output is keyed by pid, because ps reorders', () => {
  const samples = parsePsOutput(['  4242  35840   0:02.30', '  17    36100   0:01.00'].join('\n'));
  assert.deepEqual(samples, [
    { pid: 4242, rssBytes: 35840 * 1024, cpuSeconds: 2.3 },
    { pid: 17, rssBytes: 36100 * 1024, cpuSeconds: 1 },
  ]);
});

test('unparseable ps lines are skipped rather than poisoning the sample', () => {
  const samples = parsePsOutput('header junk\n  1  100  0:01.00\nbroken\n');
  assert.equal(samples.length, 1);
  assert.equal(samples[0]?.pid, 1);
});

test('/proc/net/dev totals every interface but loopback', () => {
  const text = [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '    lo: 1000       10    0    0    0     0          0         0     1000      10    0    0    0     0       0          0',
    '  eth0: 5000       50    0    0    0     0          0         0     2000      20    0    0    0     0       0          0',
    '  eth1:  500        5    0    0    0     0          0         0      100       1    0    0    0     0       0          0',
  ].join('\n');
  assert.deepEqual(parseProcNetDev(text), { rxBytes: 5500, txBytes: 2100 });
});

test('a /proc/net/dev with nothing but loopback is no data, not zero', () => {
  const text = '    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0';
  assert.equal(parseProcNetDev(text), undefined);
  assert.equal(parseProcNetDev('garbage'), undefined);
});

test('netstat counts each interface once, from the Link row', () => {
  // The address rows repeat the same counters, so summing every row would
  // triple a dual-stack interface. The Address column is also blank on the
  // Link rows, which shifts every field index.
  const text = [
    'Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll',
    'lo0        16384 <Link#1>                       4021765     0  258722763  4021765     0  258722763     0',
    'lo0        16384 127           127.0.0.1        4021765     -  258722763  4021765     -  258722763     -',
    'en0        1500  <Link#5>    a1:b2:c3:d4:e5:f6   100000     0    9000000    50000     0    1000000     0',
    'en0        1500  192.168.1     192.168.1.10      100000     -    9000000    50000     -    1000000     -',
    'en0        1500  fe80::1%en0 fe80:5::1           100000     -    9000000    50000     -    1000000     -',
    'gif0*      1280  <Link#2>                             0     0          0        0     0          0     0',
  ].join('\n');
  assert.deepEqual(parseNetstatInterfaces(text), { rxBytes: 9_000_000, txBytes: 1_000_000 });
});

test('a rate needs two samples, and a counter reset reports nothing', () => {
  const meter = new RateMeter();
  assert.deepEqual(meter.sample(1_000, { rxBytes: 1_000, txBytes: 100 }), {});
  assert.deepEqual(meter.sample(2_000, { rxBytes: 3_000, txBytes: 300 }), {
    rxBytesPerSec: 2_000,
    txBytesPerSec: 200,
  });
  // An interface that went away takes the counters with it: no negative rates.
  assert.deepEqual(meter.sample(3_000, { rxBytes: 10, txBytes: 1 }), {});
  assert.deepEqual(meter.sample(4_000, undefined), {});
});

test('cpu utilisation is the busy share of the interval, not of all time', () => {
  let ticks = { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
  const meter = new CpuMeter(() => [
    { model: 'test', speed: 1, times: { ...ticks } },
    { model: 'test', speed: 1, times: { ...ticks } },
  ]);
  // First call primes: there is no interval to divide by yet.
  assert.equal(meter.sample(), undefined);
  ticks = { user: 250, nice: 0, sys: 0, idle: 750, irq: 0 };
  assert.equal(meter.sample(), 0.25);
  // Half of the next interval busy, even though the total is now 40% busy.
  ticks = { user: 750, nice: 0, sys: 0, idle: 1_250, irq: 0 };
  assert.equal(meter.sample(), 0.5);
});
