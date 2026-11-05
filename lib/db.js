import crypto from 'node:crypto'
import { neon } from '@neondatabase/serverless'
import { DATABASE_URL, HttpError } from './config.js'
import { decrypt, encrypt } from './crypto.js'

/* ------------------------------------------------------------------ setup */

// One tagged-template query function. The Neon driver sends each query over
// HTTPS, which suits serverless hosts (no long-lived connections to manage).
// Values in ${...} are sent as parameters, never glued into the SQL text, so
// they cannot cause SQL injection.
const query = DATABASE_URL ? neon(DATABASE_URL) : null

function db() {
  if (!query) {
    throw new HttpError(503, 'The database is not set up yet. Add DATABASE_URL to your .env file and restart.')
  }
  return query
}

// Creates the tables the first time the app talks to the database. Safe to run
// every time ("IF NOT EXISTS"), and remembered so it only runs once per process.
let ready = null
export function ensureSchema() {
  ready ??= (async () => {
    const sql = db()
    await sql`
      CREATE TABLE IF NOT EXISTS clients (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id    text NOT NULL,          -- the Buffer account that owns this client
        name        text NOT NULL,
        link_hash   text NOT NULL UNIQUE,   -- SHA-256 of the private link's token
        created_at  timestamptz NOT NULL DEFAULT now(),
        link_made_at timestamptz NOT NULL DEFAULT now()
      )`
    await sql`CREATE INDEX IF NOT EXISTS clients_owner_idx ON clients (owner_id)`
    // Added later, so they use ADD COLUMN IF NOT EXISTS (safe on existing tables).
    await sql`ALTER TABLE clients ADD COLUMN IF NOT EXISTS organization_id text`
    await sql`ALTER TABLE clients ADD COLUMN IF NOT EXISTS tag_id text`
    // Everything a client has sent, and what happened to it in Buffer.
    await sql`
      CREATE TABLE IF NOT EXISTS submissions (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id   uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        title       text NOT NULL,
        body        text NOT NULL,
        details     text,
        timing_note text,
        preferred_date text,
        photos      jsonb NOT NULL DEFAULT '[]',
        status      text NOT NULL DEFAULT 'pending',  -- pending | sent | failed
        idea_id     text,
        error       text,
        created_at  timestamptz NOT NULL DEFAULT now()
      )`
    await sql`CREATE INDEX IF NOT EXISTS submissions_client_idx ON submissions (client_id, created_at DESC)`
    // The manager's Buffer connection, kept server-side so the app can act for
    // them when a client (who is not signed in) submits something.
    await sql`
      CREATE TABLE IF NOT EXISTS owners (
        account_id        text PRIMARY KEY,   -- Buffer account id
        access_token_enc  text NOT NULL,
        refresh_token_enc text NOT NULL,
        expires_at        bigint NOT NULL,    -- ms since 1970
        scope             text,
        connected_at      bigint NOT NULL,
        refreshing_until  timestamptz         -- set while one request renews the tokens
      )`
  })().catch((err) => {
    ready = null // try again next time instead of caching a failure
    throw err
  })
  return ready
}

/* ------------------------------------------------------------ private links */

// 32 random bytes = 256 bits of randomness, written as 43 URL-safe characters.
// There are more possible links than atoms in the Earth, so guessing is hopeless.
export function createLinkToken() {
  return crypto.randomBytes(32).toString('base64url')
}

// Only this fingerprint is stored. A leaked database therefore does not leak
// working links. (A plain SHA-256 is right for long random tokens; slow password
// hashes are only needed for short human-chosen secrets.)
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

// Reject anything that cannot possibly be one of our links before touching the DB.
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

/* ------------------------------------------------------- Buffer connection */

function ownerFromRow(row) {
  if (!row) return null
  const accessToken = decrypt(row.access_token_enc)
  const refreshToken = decrypt(row.refresh_token_enc)
  if (!accessToken || !refreshToken) return null // unreadable: treat as not connected
  return {
    accountId: row.account_id,
    accessToken,
    refreshToken,
    expiresAt: Number(row.expires_at),
    scope: row.scope,
    connectedAt: Number(row.connected_at),
  }
}

export async function getOwner(accountId) {
  await ensureSchema()
  const rows = await db()`SELECT * FROM owners WHERE account_id = ${accountId}`
  return ownerFromRow(rows[0])
}

// Saves a fresh token pair and releases the renewal lock.
export async function saveOwner(accountId, tokens) {
  await ensureSchema()
  await db()`
    INSERT INTO owners (account_id, access_token_enc, refresh_token_enc, expires_at, scope, connected_at, refreshing_until)
    VALUES (${accountId}, ${encrypt(tokens.accessToken)}, ${encrypt(tokens.refreshToken)},
            ${tokens.expiresAt}, ${tokens.scope ?? null}, ${tokens.connectedAt}, NULL)
    ON CONFLICT (account_id) DO UPDATE SET
      access_token_enc = EXCLUDED.access_token_enc,
      refresh_token_enc = EXCLUDED.refresh_token_enc,
      expires_at = EXCLUDED.expires_at,
      scope = EXCLUDED.scope,
      connected_at = EXCLUDED.connected_at,
      refreshing_until = NULL`
}

export async function deleteOwner(accountId) {
  await ensureSchema()
  await db()`DELETE FROM owners WHERE account_id = ${accountId}`
}

// Buffer refresh tokens work once: using one invalidates it, and using an old one
// again cancels the whole connection. So only ONE request may renew at a time.
// This claims the right to do it: exactly one caller gets the row back, for 30s.
export async function claimRefresh(accountId) {
  await ensureSchema()
  const rows = await db()`
    UPDATE owners SET refreshing_until = now() + interval '30 seconds'
    WHERE account_id = ${accountId} AND (refreshing_until IS NULL OR refreshing_until < now())
    RETURNING *`
  return ownerFromRow(rows[0])
}

export async function releaseRefresh(accountId) {
  await ensureSchema()
  await db()`UPDATE owners SET refreshing_until = NULL WHERE account_id = ${accountId}`
}

/* ---------------------------------------------------------------- clients */

const MAX_CLIENTS_PER_OWNER = 50

export async function createClient(ownerId, name) {
  await ensureSchema()
  const sql = db()
  const [{ count }] = await sql`SELECT count(*)::int AS count FROM clients WHERE owner_id = ${ownerId}`
  if (count >= MAX_CLIENTS_PER_OWNER) throw new HttpError(400, `You can have up to ${MAX_CLIENTS_PER_OWNER} clients.`)

  const token = createLinkToken()
  const [client] = await sql`
    INSERT INTO clients (owner_id, name, link_hash)
    VALUES (${ownerId}, ${name}, ${hashToken(token)})
    RETURNING id, name, created_at`
  return { client, token }
}

export async function listClients(ownerId) {
  await ensureSchema()
  return db()`SELECT id, name, created_at, link_made_at FROM clients WHERE owner_id = ${ownerId} ORDER BY created_at DESC`
}

// Replaces a client's link. The old link stops working immediately.
// The owner_id check means one manager can never touch another manager's client.
export async function renewClientLink(ownerId, clientId) {
  await ensureSchema()
  const token = createLinkToken()
  const rows = await db()`
    UPDATE clients SET link_hash = ${hashToken(token)}, link_made_at = now()
    WHERE id = ${clientId} AND owner_id = ${ownerId}
    RETURNING id, name`
  if (!rows.length) throw new HttpError(404, 'Client not found')
  return { client: rows[0], token }
}

export async function deleteClient(ownerId, clientId) {
  await ensureSchema()
  const rows = await db()`DELETE FROM clients WHERE id = ${clientId} AND owner_id = ${ownerId} RETURNING id`
  if (!rows.length) throw new HttpError(404, 'Client not found')
}

// The only lookup the public (no-login) side can do: token in, that one client out.
export async function findClientByToken(token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null
  await ensureSchema()
  const rows = await db()`
    SELECT id, owner_id, name, organization_id, tag_id FROM clients WHERE link_hash = ${hashToken(token)} LIMIT 1`
  return rows[0] || null
}

export async function rememberClientBuffer(clientId, { organizationId, tagId }) {
  await ensureSchema()
  await db()`
    UPDATE clients SET
      organization_id = COALESCE(${organizationId ?? null}, organization_id),
      tag_id = COALESCE(${tagId ?? null}, tag_id)
    WHERE id = ${clientId}`
}

/* ------------------------------------------------------------ submissions */

export async function recentSubmissionCount(clientId, hours = 24) {
  await ensureSchema()
  const [{ count }] = await db()`
    SELECT count(*)::int AS count FROM submissions
    WHERE client_id = ${clientId} AND created_at > now() - make_interval(hours => ${hours})`
  return count
}

export async function createSubmission(clientId, s) {
  await ensureSchema()
  const [row] = await db()`
    INSERT INTO submissions (client_id, title, body, details, timing_note, preferred_date, photos)
    VALUES (${clientId}, ${s.title}, ${s.text}, ${s.details || null}, ${s.timing || null},
            ${s.date || null}, ${JSON.stringify(s.photos)}::jsonb)
    RETURNING id`
  return row.id
}

export async function finishSubmission(id, { ideaId = null, error = null }) {
  await ensureSchema()
  await db()`UPDATE submissions SET status = ${error ? 'failed' : 'sent'}, idea_id = ${ideaId}, error = ${error} WHERE id = ${id}`
}
