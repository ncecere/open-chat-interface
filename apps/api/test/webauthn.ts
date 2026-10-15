import {
  createHash,
  createSign,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
} from 'node:crypto';

/**
 * A software WebAuthn authenticator for tests (ES256, "none" attestation), so
 * passkey registration and sign-in run against the real Better Auth plugin and
 * the real @simplewebauthn/server verification without a browser. The browser
 * suites use Chromium's virtual authenticator instead.
 *
 * `userVerified` sets the UV flag in what the authenticator signs: false is a
 * PIN-less security key that only proved presence.
 */

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest();

/** Minimal CBOR for the shapes WebAuthn needs: unsigned and negative integers, byte and text strings, maps. */
function cbor(value: unknown): Buffer {
  const head = (major: number, length: number) => {
    if (length < 24) return Buffer.from([(major << 5) | length]);
    if (length < 256) return Buffer.from([(major << 5) | 24, length]);
    return Buffer.from([(major << 5) | 25, length >> 8, length & 255]);
  };
  if (typeof value === 'number') {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === 'string') {
    const text = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, text.length), text]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map) {
    return Buffer.concat([
      head(5, value.size),
      ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)]),
    ]);
  }
  throw new Error('Unsupported CBOR value');
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

export interface RegistrationOptionsJSON {
  challenge: string;
  rp: { id?: string; name: string };
  excludeCredentials?: Array<{ id: string }>;
  authenticatorSelection?: { userVerification?: string; residentKey?: string };
}

export interface AuthenticationOptionsJSON {
  challenge: string;
  rpId?: string;
  userVerification?: string;
}

export class SoftwareAuthenticator {
  readonly credentialId = randomBytes(32);
  readonly aaguid: Buffer;
  private readonly privateKey: KeyObject;
  private readonly publicKeyJwk: { x: string; y: string };
  private counter = 0;

  constructor(
    private readonly config: {
      origin: string;
      rpId: string;
      /** Whether the authenticator verified the user (PIN or biometric). */
      userVerified?: boolean;
      /** A fixed AAGUID, otherwise all zeros as privacy-preserving platforms report. */
      aaguid?: Buffer;
      /** The credential is synced between devices (backup eligible and backed up). */
      backedUp?: boolean;
    },
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    this.publicKeyJwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    this.aaguid = config.aaguid ?? Buffer.alloc(16);
  }

  get id(): string {
    return b64url(this.credentialId);
  }

  private flags(extra: number): number {
    return (
      FLAG_UP |
      (this.config.userVerified === false ? 0 : FLAG_UV) |
      (this.config.backedUp ? FLAG_BE | FLAG_BS : 0) |
      extra
    );
  }

  private clientData(type: string, challenge: string): Buffer {
    return Buffer.from(
      JSON.stringify({ type, challenge, origin: this.config.origin, crossOrigin: false }),
    );
  }

  /** Answers `generate-register-options` with a registration response for `verify-registration`. */
  register(options: RegistrationOptionsJSON) {
    const counter = Buffer.alloc(4);
    const coseKey = cbor(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(this.publicKeyJwk.x, 'base64url')],
        [-3, Buffer.from(this.publicKeyJwk.y, 'base64url')],
      ]),
    );
    const credentialLength = Buffer.alloc(2);
    credentialLength.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      sha256(this.config.rpId),
      Buffer.from([this.flags(FLAG_AT)]),
      counter,
      this.aaguid,
      credentialLength,
      this.credentialId,
      coseKey,
    ]);
    const attestationObject = cbor(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(this.clientData('webauthn.create', options.challenge)),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
    };
  }

  /** Answers `generate-authenticate-options` with an assertion for `verify-authentication`. */
  authenticate(options: AuthenticationOptionsJSON) {
    this.counter += 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const authData = Buffer.concat([
      sha256(this.config.rpId),
      Buffer.from([this.flags(0)]),
      counter,
    ]);
    const clientDataJSON = this.clientData('webauthn.get', options.challenge);
    const signature = createSign('sha256')
      .update(Buffer.concat([authData, sha256(clientDataJSON)]))
      .sign(this.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        authenticatorData: b64url(authData),
        clientDataJSON: b64url(clientDataJSON),
        signature: b64url(signature),
      },
    };
  }
}
