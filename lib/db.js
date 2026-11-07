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
    // Draft posts a manager has shared with a client for approval. `snapshot` is a
    // copy of what the client sees (text, images, channel), taken when shared, so
    // opening the client page never needs a call to Buffer.
    await sql`
      CREATE TABLE IF NOT EXISTS shares (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id      uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        post_id        text NOT NULL,
        snapshot       jsonb NOT NULL,
        status         text NOT NULL DEFAULT 'waiting',   -- waiting | approved | changes
        feedback       text,
        decision_count int NOT NULL DEFAULT 0,
        note_saved     boolean,                           -- did the Buffer Note get created?
        note_error     text,
        decided_at     timestamptz,
        created_at     timestamptz NOT NULL DEFAULT now(),
        UNIQUE (client_id, post_id)
      )`
    await sql`ALTER TABLE shares ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'` // manual | auto
    await sql`ALTER TABLE shares ADD COLUMN IF NOT EXISTS notified_at timestamptz`
    // Small key/value store (holds the app's push-notification keys).
    await sql`CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value text NOT NULL)`
    // One row per browser or phone the manager turned notifications on for.
    await sql`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id   text NOT NULL,
        endpoint   text NOT NULL UNIQUE,
        p256dh     text NOT NULL,
        auth       text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`
    await sql`CREATE INDEX IF NOT EXISTS push_owner_idx ON push_subscriptions (owner_id)`
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
    await sql`ALTER TABLE owners ADD COLUMN IF NOT EXISTS organization_id text`
    await sql`ALTER TABLE owners ADD COLUMN IF NOT EXISTS last_sync_at timestamptz`
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
  // Names must be unique: Handoff matches Buffer tags and drafts to clients by name.
  const [{ taken }] = await sql`
    SELECT count(*)::int AS taken FROM clients WHERE owner_id = ${ownerId} AND lower(name) = lower(${name})`
  if (taken) throw new HttpError(400, 'You already have a client with that name.')

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

/* ------------------------------------------------------------ notifications */

export async function getSetting(key) {
  await ensureSchema()
  const rows = await db()`SELECT value FROM settings WHERE key = ${key}`
  return rows[0]?.value ?? null
}

// First writer wins, so two servers starting at once can never end up with
// different keys.
export async function setSettingIfAbsent(key, value) {
  await ensureSchema()
  await db()`INSERT INTO settings (key, value) VALUES (${key}, ${value}) ON CONFLICT (key) DO NOTHING`
}

const MAX_SUBSCRIPTIONS_PER_OWNER = 10

export async function saveSubscription(ownerId, { endpoint, p256dh, auth }) {
  await ensureSchema()
  const sql = db()
  const [{ count }] = await sql`SELECT count(*)::int AS count FROM push_subscriptions WHERE owner_id = ${ownerId} AND endpoint <> ${endpoint}`
  if (count >= MAX_SUBSCRIPTIONS_PER_OWNER) throw new HttpError(400, 'Too many devices have notifications on. Turn some off first.')
  await sql`
    INSERT INTO push_subscriptions (owner_id, endpoint, p256dh, auth) VALUES (${ownerId}, ${endpoint}, ${p256dh}, ${auth})
    ON CONFLICT (endpoint) DO UPDATE SET owner_id = EXCLUDED.owner_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`
}

export async function listSubscriptions(ownerId) {
  await ensureSchema()
  return db()`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE owner_id = ${ownerId}`
}

// Owner-scoped, so one manager can never remove another manager's device.
export async function deleteSubscription(endpoint, ownerId = null) {
  await ensureSchema()
  if (ownerId) await db()`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint} AND owner_id = ${ownerId}`
  else await db()`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint}`
}

/* ----------------------------------------------------------------- shares */
// Every manager-side query joins through `clients` and checks owner_id, so a
// manager can only ever touch shares that belong to their own clients.

export const MAX_DECISIONS_PER_SHARE = 10

// Shares a draft with a client. Sharing the same post again refreshes the
// snapshot and puts it back to "waiting" (used after the manager edits it).
export async function createShare(ownerId, clientId, postId, snapshot) {
  await ensureSchema()
  const rows = await db()`
    INSERT INTO shares (client_id, post_id, snapshot)
    SELECT c.id, ${postId}, ${JSON.stringify(snapshot)}::jsonb FROM clients c
    WHERE c.id = ${clientId} AND c.owner_id = ${ownerId}
    ON CONFLICT (client_id, post_id) DO UPDATE SET
      snapshot = EXCLUDED.snapshot, status = 'waiting', feedback = NULL,
      decision_count = 0, note_saved = NULL, note_error = NULL, decided_at = NULL
    RETURNING id`
  if (!rows.length) throw new HttpError(404, 'Client not found')
  return rows[0].id
}

export async function listSharesForOwner(ownerId) {
  await ensureSchema()
  return db()`
    SELECT s.id, s.post_id, s.snapshot, s.status, s.feedback, s.note_saved, s.decided_at, s.created_at,
           c.id AS client_id, c.name AS client_name
    FROM shares s JOIN clients c ON c.id = s.client_id
    WHERE c.owner_id = ${ownerId}
    ORDER BY COALESCE(s.decided_at, s.created_at) DESC
    LIMIT 200`
}

export async function deleteShare(ownerId, shareId) {
  await ensureSchema()
  const rows = await db()`
    DELETE FROM shares s USING clients c
    WHERE s.id = ${shareId} AND s.client_id = c.id AND c.owner_id = ${ownerId} RETURNING s.id`
  if (!rows.length) throw new HttpError(404, 'Not found')
}

export async function listSharesForClient(clientId) {
  await ensureSchema()
  return db()`
    SELECT id, snapshot, status, feedback, decided_at, created_at
    FROM shares WHERE client_id = ${clientId} ORDER BY created_at DESC LIMIT 50`
}

// Used by automatic matching: never touches a share that already exists, so a
// client's earlier answer is never reset behind their back.
export async function createShareIfAbsent(clientId, postId, snapshot, source = 'auto') {
  await ensureSchema()
  const rows = await db()`
    INSERT INTO shares (client_id, post_id, snapshot, source)
    VALUES (${clientId}, ${postId}, ${JSON.stringify(snapshot)}::jsonb, ${source})
    ON CONFLICT (client_id, post_id) DO NOTHING RETURNING id`
  return rows.length > 0
}

// Everything needed to decide which client a Buffer draft belongs to.
export async function listMatchData(ownerId) {
  await ensureSchema()
  const clients = await db()`SELECT id, name FROM clients WHERE owner_id = ${ownerId}`
  const bodies = await db()`
    SELECT s.client_id, s.body FROM submissions s JOIN clients c ON c.id = s.client_id
    WHERE c.owner_id = ${ownerId} AND s.status = 'sent'`
  return { clients, bodies }
}

// Lets at most one request per minute talk to Buffer to look for new drafts.
// Both the dashboard and the client page ask, so a draft shows up within a minute
// without hammering Buffer's (small, shared) rate limit.
export async function claimSync(ownerId, seconds = 60) {
  await ensureSchema()
  const rows = await db()`
    UPDATE owners SET last_sync_at = now()
    WHERE account_id = ${ownerId}
      AND (last_sync_at IS NULL OR last_sync_at < now() - make_interval(secs => ${seconds}))
    RETURNING account_id`
  return rows.length > 0
}

export async function getOwnerOrganization(ownerId) {
  await ensureSchema()
  const rows = await db()`SELECT organization_id FROM owners WHERE account_id = ${ownerId}`
  return rows[0]?.organization_id || null
}

export async function setOwnerOrganization(ownerId, organizationId) {
  await ensureSchema()
  await db()`UPDATE owners SET organization_id = ${organizationId} WHERE account_id = ${ownerId}`
}

// The client may only act on a share that belongs to THEIR link's client.
export async function getShareForClient(clientId, shareId) {
  await ensureSchema()
  const rows = await db()`
    SELECT id, post_id, status, decision_count, snapshot FROM shares WHERE id = ${shareId} AND client_id = ${clientId}`
  return rows[0] || null
}

export async function recordDecision(shareId, { status, feedback, noteSaved, noteError }) {
  await ensureSchema()
  await db()`
    UPDATE shares SET status = ${status}, feedback = ${feedback || null}, decision_count = decision_count + 1,
      note_saved = ${noteSaved}, note_error = ${noteError || null}, decided_at = now()
    WHERE id = ${shareId}`
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
