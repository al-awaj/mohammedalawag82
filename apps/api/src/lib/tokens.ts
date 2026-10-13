import { createHash, randomBytes, randomInt } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

export interface AccessClaims {
  sub: string;
  kind: 'customer' | 'provider' | 'staff';
}

export class TokenService {
  private readonly key: Uint8Array;
  constructor(secret: string, private readonly ttlSeconds: number) {
    this.key = new TextEncoder().encode(secret);
  }

  async signAccess(claims: AccessClaims): Promise<string> {
    return new SignJWT({ kind: claims.kind })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .setIssuer('events-platform')
      .sign(this.key);
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    const { payload } = await jwtVerify(token, this.key, { issuer: 'events-platform', algorithms: ['HS256'] });
    const kind = payload.kind;
    if (!payload.sub || (kind !== 'customer' && kind !== 'provider' && kind !== 'staff')) {
      throw new Error('invalid claims');
    }
    return { sub: payload.sub, kind };
  }
}

export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');
export const randomOtp = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
