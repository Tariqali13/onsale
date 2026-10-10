import { createHash } from 'node:crypto';
import type { Db } from '../db/pool.js';
import { AppError } from '../lib/errors.js';

export interface StoredResponse {
  statusCode: number;
  body: unknown;
}

export type BeginResult = { kind: 'new' } | { kind: 'replay'; response: StoredResponse };

export function hashRequest(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

/**
 * Stripe-style idempotency keys.
 *  - First request with a key claims it ('in_progress').
 *  - A retry with the same key + same body replays the stored response.
 *  - Same key + different body is a client bug → 422.
 *  - A retry while the first is still running → 409 (client should back off and retry).
 */
export class IdempotencyStore {
  constructor(private readonly db: Db) {}

  async begin(session: string, key: string, requestHash: string): Promise<BeginResult> {
    const inserted = await this.db.query(
      `INSERT INTO idempotency_keys (key, session_id, request_hash, status)
       VALUES ($1, $2, $3, 'in_progress') ON CONFLICT DO NOTHING`,
      [key, session, requestHash],
    );
    if (inserted.rowCount === 1) return { kind: 'new' };

    const { rows } = await this.db.query<{
      request_hash: string;
      status: string;
      response_code: number | null;
      response_body: unknown;
    }>('SELECT request_hash, status, response_code, response_body FROM idempotency_keys WHERE key = $1 AND session_id = $2', [
      key,
      session,
    ]);
    const row = rows[0];
    if (!row) throw new AppError(409, 'idempotency_conflict', 'Idempotency key state changed, retry the request');
    if (row.request_hash !== requestHash) {
      throw new AppError(422, 'idempotency_key_reused', 'This Idempotency-Key was already used with a different request body');
    }
    if (row.status === 'in_progress') {
      throw new AppError(409, 'request_in_progress', 'A request with this Idempotency-Key is still being processed');
    }
    return { kind: 'replay', response: { statusCode: row.response_code!, body: row.response_body } };
  }

  async attachOrder(session: string, key: string, orderId: string): Promise<void> {
    await this.db.query('UPDATE idempotency_keys SET order_id = $3 WHERE key = $1 AND session_id = $2', [key, session, orderId]);
  }

  async complete(session: string, key: string, response: StoredResponse): Promise<void> {
    await this.db.query(
      `UPDATE idempotency_keys SET status = 'completed', response_code = $3, response_body = $4
       WHERE key = $1 AND session_id = $2`,
      [key, session, response.statusCode, JSON.stringify(response.body)],
    );
  }

  /** Release a key whose request failed before doing anything irreversible, so the client may retry. */
  async abandon(session: string, key: string): Promise<void> {
    await this.db.query(`DELETE FROM idempotency_keys WHERE key = $1 AND session_id = $2 AND order_id IS NULL`, [key, session]);
  }

  async completeByOrder(orderId: string, response: StoredResponse): Promise<void> {
    await this.db.query(
      `UPDATE idempotency_keys SET status = 'completed', response_code = $2, response_body = $3
       WHERE order_id = $1 AND status = 'in_progress'`,
      [orderId, response.statusCode, JSON.stringify(response.body)],
    );
  }

  async purgeOlderThan(hours: number): Promise<number> {
    const res = await this.db.query(`DELETE FROM idempotency_keys WHERE created_at < now() - make_interval(hours => $1)`, [hours]);
    return res.rowCount ?? 0;
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
