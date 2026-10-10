import { SignJWT, jwtVerify } from 'jose';
import { AppError } from '../lib/errors.js';

export interface AccessClaims {
  session: string;
  eventId: string;
}

/**
 * Short-lived signed pass handed to a session once it leaves the waiting room.
 * Protected routes verify the signature statelessly (cheap) and then confirm the
 * session is still in the active set (so admins can revoke and windows expire).
 */
export class AccessTokens {
  private readonly key: Uint8Array;

  constructor(secret: string) {
    this.key = new TextEncoder().encode(secret);
  }

  async issue(claims: AccessClaims, expiresAtMs: number): Promise<string> {
    return new SignJWT({ evt: claims.eventId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.session)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAtMs / 1000))
      .setAudience('onsale:shop')
      .sign(this.key);
  }

  async verify(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, { audience: 'onsale:shop', algorithms: ['HS256'] });
      if (typeof payload.sub !== 'string' || typeof payload.evt !== 'string') throw new Error('malformed claims');
      return { session: payload.sub, eventId: payload.evt };
    } catch {
      throw new AppError(401, 'invalid_access_token', 'Your access pass is invalid or has expired. Please rejoin the queue.');
    }
  }
}
