import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { redisTls } from '../src/lib/redis.js';

describe('config', () => {
  it('rejects a pasted redis-cli command without echoing the password', () => {
    const secret = 'sup3rS3cretPassw0rd';
    const bad = `redis-cli --tls -u redis://default:${secret}@example.upstash.io:6379`;
    let message = '';
    try {
      loadConfig({ REDIS_URL: bad });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/REDIS_URL: must be a single redis:\/\/ or rediss:\/\/ URL/);
    expect(message).not.toContain(secret);
  });

  it('accepts redis:// and rediss:// URLs', () => {
    expect(loadConfig({ REDIS_URL: 'rediss://default:pw@host.upstash.io:6379' }).REDIS_URL).toMatch(/^rediss:/);
    expect(loadConfig({ REDIS_URL: 'redis://localhost:6379/2' }).REDIS_URL).toBe('redis://localhost:6379/2');
  });
});

describe('redisTls', () => {
  it('uses TLS for rediss:// and for Upstash hosts pasted as redis://', () => {
    expect(redisTls('rediss://h:6379')).toEqual({});
    expect(redisTls('redis://default:pw@cosmic-kiwi.upstash.io:6379')).toEqual({});
    expect(redisTls('redis://localhost:6379')).toBeUndefined();
  });
});
