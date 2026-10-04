/**
 * Deterministic randomness for the scale harness.
 *
 * Everything the generator produces is a function of (seed, profile, now), so
 * two runs with the same inputs write identical rows, and worker threads can
 * generate any slice of the dataset without coordinating: each entity draws
 * from its own stream, keyed by what it is and its index.
 */

/** FNV-1a, 32 bits. Used to turn names and seeds into stream keys. */
export function hashString(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** murmur3's finaliser: a bijection on 32-bit integers with good avalanche. */
export function mix32(value) {
  let h = value >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A uniform number in [0, 1) that depends only on its inputs. */
export function hash01(a, b, c = 0) {
  return mix32(mix32(a ^ mix32(b + 0x9e3779b9)) ^ mix32(c + 0x7f4a7c15)) / 4294967296;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function hex32(value) {
  return (
    HEX[(value >>> 24) & 255] +
    HEX[(value >>> 16) & 255] +
    HEX[(value >>> 8) & 255] +
    HEX[value & 255]
  );
}

/**
 * A version-4-shaped UUID for entity `index` of `kind`. The first word is a
 * bijection of the index, so two entities of one kind never collide; the rest
 * only has to look random.
 */
export function entityId(seedHash, kind, index) {
  const kindKey = hashString(kind) ^ seedHash;
  const w0 = mix32(index ^ kindKey);
  const w1 = mix32(w0 ^ mix32(kindKey + 1));
  const w2 = mix32(w1 ^ mix32(index + 0x2545f491));
  const w3 = mix32(w2 ^ w0 ^ kindKey);
  const a = hex32(w0);
  const b = hex32(w1);
  const c = hex32(((w2 & 0x3fffffff) | 0x80000000) >>> 0);
  const d = hex32(w3);
  return `${a}-${b.slice(0, 4)}-4${b.slice(5, 8)}-${c.slice(0, 4)}-${c.slice(4)}${d}`;
}

/** sfc32: small, fast and statistically sound for simulation work. */
export class Rng {
  constructor(seedHash, stream = 0, index = 0) {
    this.a = mix32(seedHash ^ 0x9e3779b9);
    this.b = mix32(stream ^ 0x243f6a88);
    this.c = mix32(index ^ 0xb7e15162);
    this.d = 1;
    for (let i = 0; i < 12; i++) this.u32();
  }

  u32() {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  float() {
    return this.u32() / 4294967296;
  }

  /** An integer in [0, n). */
  int(n) {
    return Math.floor(this.float() * n);
  }

  /** An integer in [min, max]. */
  range(min, max) {
    return min + this.int(max - min + 1);
  }

  chance(p) {
    return this.float() < p;
  }

  pick(items) {
    return items[this.int(items.length)];
  }

  normal() {
    const u = 1 - this.float();
    const v = this.float();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  lognormal(mu, sigma) {
    return Math.exp(mu + sigma * this.normal());
  }

  /** Pareto with scale 1: long-tailed, as activity per person is. */
  pareto(alpha) {
    return (1 - this.float()) ** (-1 / alpha);
  }

  /** URL-safe random token of `bytes` bytes, like the API's share slugs and session tokens. */
  token(bytes) {
    const buffer = Buffer.allocUnsafe(bytes);
    for (let i = 0; i < bytes; i += 4) {
      const value = this.u32();
      for (let j = 0; j < 4 && i + j < bytes; j++) buffer[i + j] = (value >>> (j * 8)) & 255;
    }
    return buffer.toString('base64url');
  }

  hex(bytes) {
    let out = '';
    for (let i = 0; i < bytes; i += 4) out += hex32(this.u32());
    return out.slice(0, bytes * 2);
  }
}

/**
 * Splits `total` into integers proportional to `weights` (a Float64Array),
 * each at least `min` and at most `max`, summing exactly to `total`.
 * Deterministic: the remainder goes to entries chosen by `rng`.
 */
export function allocate(total, weights, rng, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  const n = weights.length;
  const out = new Int32Array(n);
  if (n === 0) return out;
  if (total < min * n) throw new Error(`Cannot allocate ${total} across ${n} with minimum ${min}`);
  if (total > max * n) throw new Error(`Cannot allocate ${total} across ${n} with maximum ${max}`);
  out.fill(min);
  let remaining = total - min * n;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += weights[i];
  if (sum <= 0) {
    for (let i = 0; i < n && remaining > 0; i++) {
      const add = Math.min(remaining, max - out[i]);
      out[i] += add;
      remaining -= add;
    }
    return out;
  }
  const scale = remaining / sum;
  let assigned = 0;
  for (let i = 0; i < n; i++) {
    const add = Math.min(max - out[i], Math.floor(weights[i] * scale + rng.float()));
    out[i] += add;
    assigned += add;
  }
  let diff = remaining - assigned;
  // Fix the rounding drift one unit at a time at random positions that can
  // take it; weighted entries are preferred so zero-weight entries stay small.
  let guard = 0;
  while (diff !== 0 && guard < 50 * n + 1000) {
    const i = rng.int(n);
    guard++;
    if (diff > 0 && out[i] < max && (weights[i] > 0 || guard > 20 * n)) {
      out[i]++;
      diff--;
    } else if (diff < 0 && out[i] > min) {
      out[i]--;
      diff++;
    }
  }
  if (diff !== 0) {
    for (let i = 0; i < n && diff !== 0; i++) {
      while (diff > 0 && out[i] < max) {
        out[i]++;
        diff--;
      }
      while (diff < 0 && out[i] > min) {
        out[i]--;
        diff++;
      }
    }
  }
  return out;
}
