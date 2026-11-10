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
    await sql`ALTER TABLE clients ADD COLUMN IF NOT EXISTS archived_at timestamptz`      // finished clients
    await sql`ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_opened_at timestamptz`   // when they last opened their link
    await sql`ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_nudged_at timestamptz`   // when they were last reminded
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
    await sql`ALTER TABLE shares ADD COLUMN IF NOT EXISTS manager_note text`   // "what I changed", shown to the client
    await sql`ALTER TABLE shares ADD COLUMN IF NOT EXISTS updated_at timestamptz`
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
    // Devices a CLIENT turned notifications on for (kept apart from the manager's).
    await sql`
      CREATE TABLE IF NOT EXISTS client_push_subscriptions (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id  uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        endpoint   text NOT NULL,
        p256dh     text NOT NULL,
        auth       text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (client_id, endpoint)
      )`
    // A timeline of everything that happens: a draft shared, a client approving or
    // asking for changes, a revised version sent back, new content arriving. It
    // feeds the History tab and gives every action a date and time.
    await sql`
      CREATE TABLE IF NOT EXISTS events (
        id         bigserial PRIMARY KEY,
        client_id  uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        share_id   uuid REFERENCES shares(id) ON DELETE SET NULL,
        kind       text NOT NULL,   -- shared | approved | changes | updated | submitted
        post_text  text,            -- a short copy of the post (or the submission title)
        service    text,
        comment    text,            -- what the client asked for / what the manager changed
        created_at timestamptz NOT NULL DEFAULT now()
      )`
    await sql`CREATE INDEX IF NOT EXISTS events_client_idx ON events (client_id, id DESC)`
    // The complete post exactly as it was at that moment, so History can show what
    // was really approved, asked about or sent. (Older entries may not have one.)
    await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS snapshot jsonb`
    // Entries made before this existed: an approval is of the final version, which is
    // still the share's current text, so that one can be filled in safely.
    await sql`
      UPDATE events e SET snapshot = s.snapshot
      FROM shares s WHERE e.share_id = s.id AND e.kind = 'approved' AND e.snapshot IS NULL`
    // One-time backfill from what already exists, only while the log is empty.
    await sql`
      INSERT INTO events (client_id, share_id, kind, post_text, service, comment, created_at)
      SELECT x.client_id, x.share_id, x.kind, x.post_text, x.service, x.comment, x.at FROM (
        SELECT s.client_id, s.id AS share_id, 'shared' AS kind, left(s.snapshot->>'text', 300) AS post_text,
               s.snapshot->>'service' AS service, NULL::text AS comment, s.created_at AS at
        FROM shares s
        UNION ALL
        SELECT s.client_id, s.id, s.status, left(s.snapshot->>'text', 300), s.snapshot->>'service', s.feedback, s.decided_at
        FROM shares s WHERE s.decided_at IS NOT NULL
      ) x
      WHERE NOT EXISTS (SELECT 1 FROM events)`
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
    // Off by default: drafts reach a client only when the manager chooses to share them.
    await sql`ALTER TABLE owners ADD COLUMN IF NOT EXISTS auto_share boolean NOT NULL DEFAULT false`
    // Set when the manager edits a post in Buffer after the client asked for changes,
    // so "Send updated version" can be offered as the obvious next step.
    await sql`ALTER TABLE shares ADD COLUMN IF NOT EXISTS edited_at timestamptz`
  })().catch((err) => {
    ready = null // try again next time instead of caching a failure
    throw err
  })
  return ready
}

/* ------------------------------------------------------------ private links */

// 16 random bytes = 128 bits of randomness, written as 22 URL-safe characters.
// That is the same strength standard security tokens use: there are about 3 x 10^38
// possible links, so guessing one is hopeless (and guessing is rate-limited too).
// Links made earlier were longer (43 characters); they keep working.
export function createLinkToken() {
  return crypto.randomBytes(16).toString('base64url')
}

// Only this fingerprint is stored. A leaked database therefore does not leak
// working links. (A plain SHA-256 is right for long random tokens; slow password
// hashes are only needed for short human-chosen secrets.)
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

// Reject anything that cannot possibly be one of our links before touching the DB.
export const TOKEN_PATTERN = /^(?:[A-Za-z0-9_-]{22}|[A-Za-z0-9_-]{43})$/

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
  // Archived clients do not count: finishing with a client frees up the space.
  const [{ count }] = await sql`SELECT count(*)::int AS count FROM clients WHERE owner_id = ${ownerId} AND archived_at IS NULL`
  if (count >= MAX_CLIENTS_PER_OWNER) throw new HttpError(400, `You can have up to ${MAX_CLIENTS_PER_OWNER} active clients. Archive finished ones to make room.`)
  // Active names must be unique: Handoff matches Buffer tags and drafts to clients by name.
  const [{ taken }] = await sql`
    SELECT count(*)::int AS taken FROM clients WHERE owner_id = ${ownerId} AND archived_at IS NULL AND lower(name) = lower(${name})`
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
  return db()`
    SELECT id, name, created_at, link_made_at, last_opened_at, last_nudged_at
    FROM clients WHERE owner_id = ${ownerId} AND archived_at IS NULL ORDER BY created_at DESC`
}

// Replaces a client's link. The old link stops working immediately.
// The owner_id check means one manager can never touch another manager's client.
export async function renewClientLink(ownerId, clientId) {
  await ensureSchema()
  const token = createLinkToken()
  const rows = await db()`
    UPDATE clients SET link_hash = ${hashToken(token)}, link_made_at = now()
    WHERE id = ${clientId} AND owner_id = ${ownerId} AND archived_at IS NULL
    RETURNING id, name`
  if (!rows.length) throw new HttpError(404, 'Client not found')
  return { client: rows[0], token }
}

/* --------------------------------------------- archive, opened, reminders */

// Finished clients leave the list and their link stops working, but their whole
// record stays, so it can be exported or the client restored.
export async function archiveClient(ownerId, clientId) {
  await ensureSchema()
  const rows = await db()`
    UPDATE clients SET archived_at = now()
    WHERE id = ${clientId} AND owner_id = ${ownerId} AND archived_at IS NULL RETURNING id, name`
  if (!rows.length) throw new HttpError(404, 'Client not found')
  return rows[0]
}

export async function restoreClient(ownerId, clientId) {
  await ensureSchema()
  const sql = db()
  const [row] = await sql`SELECT name FROM clients WHERE id = ${clientId} AND owner_id = ${ownerId} AND archived_at IS NOT NULL`
  if (!row) throw new HttpError(404, 'Client not found')
  const [{ taken }] = await sql`
    SELECT count(*)::int AS taken FROM clients WHERE owner_id = ${ownerId} AND archived_at IS NULL AND lower(name) = lower(${row.name})`
  if (taken) throw new HttpError(400, `You already have an active client called ${row.name}.`)
  // The old link was switched off when they were archived; make a fresh one so the
  // manager can send it again.
  const token = createLinkToken()
  await sql`
    UPDATE clients SET archived_at = NULL, link_hash = ${hashToken(token)}, link_made_at = now()
    WHERE id = ${clientId} AND owner_id = ${ownerId}`
  return { client: { id: clientId, name: row.name }, token }
}

export async function listArchivedClients(ownerId) {
  await ensureSchema()
  return db()`
    SELECT c.id, c.name, c.archived_at, c.created_at,
           (SELECT count(*)::int FROM events e WHERE e.client_id = c.id) AS entries
    FROM clients c WHERE c.owner_id = ${ownerId} AND c.archived_at IS NOT NULL ORDER BY c.archived_at DESC`
}

// Remembers that the client opened their page (at most once a minute per client).
export async function markOpened(clientId) {
  await ensureSchema()
  await db()`
    UPDATE clients SET last_opened_at = now()
    WHERE id = ${clientId} AND (last_opened_at IS NULL OR last_opened_at < now() - interval '1 minute')`
}

export const MIN_MINUTES_BETWEEN_REMINDERS = 30

// Claims the right to send a reminder; refuses if one went out very recently, so
// a client is never pestered. Returns the client, or throws a friendly error.
export async function claimReminder(ownerId, clientId) {
  await ensureSchema()
  const sql = db()
  const rows = await sql`
    UPDATE clients SET last_nudged_at = now()
    WHERE id = ${clientId} AND owner_id = ${ownerId} AND archived_at IS NULL
      AND (last_nudged_at IS NULL OR last_nudged_at < now() - make_interval(mins => ${MIN_MINUTES_BETWEEN_REMINDERS}))
    RETURNING id, name`
  if (rows.length) return rows[0]
  const [recent] = await sql`
    SELECT name, ceil(extract(epoch FROM (now() - last_nudged_at)) / 60)::int AS mins
    FROM clients WHERE id = ${clientId} AND owner_id = ${ownerId} AND archived_at IS NULL`
  if (!recent) throw new HttpError(404, 'Client not found')
  throw new HttpError(429, `You reminded ${recent.name} ${recent.mins} minute${recent.mins === 1 ? '' : 's'} ago. Give them a little while before nudging again.`)
}

// How many posts are waiting on this client (owner-checked, so it cannot be used
// to peek at someone else's client).
export async function countWaiting(ownerId, clientId) {
  await ensureSchema()
  const [{ n }] = await db()`
    SELECT count(*)::int AS n FROM shares s JOIN clients c ON c.id = s.client_id
    WHERE c.id = ${clientId} AND c.owner_id = ${ownerId} AND s.status = 'waiting'`
  return n
}

export async function logClientEvent(clientId, kind, comment = null) {
  await ensureSchema()
  await db()`INSERT INTO events (client_id, kind, comment) VALUES (${clientId}, ${kind}, ${comment})`
}

// Everything done for one client, oldest first, for export (owner-checked).
export async function getClientRecord(ownerId, clientId) {
  await ensureSchema()
  const sql = db()
  const [client] = await sql`
    SELECT id, name, created_at, archived_at FROM clients WHERE id = ${clientId} AND owner_id = ${ownerId}`
  if (!client) throw new HttpError(404, 'Client not found')
  const events = await sql`
    SELECT created_at, kind, post_text, service, comment, snapshot
    FROM events WHERE client_id = ${clientId} ORDER BY created_at ASC, id ASC LIMIT 5000`
  return { client, events }
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
    SELECT id, owner_id, name, organization_id, tag_id FROM clients
    WHERE link_hash = ${hashToken(token)} AND archived_at IS NULL LIMIT 1`
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

const MAX_SUBSCRIPTIONS_PER_CLIENT = 5

export async function saveClientSubscription(clientId, { endpoint, p256dh, auth }) {
  await ensureSchema()
  const sql = db()
  const [{ count }] = await sql`SELECT count(*)::int AS count FROM client_push_subscriptions WHERE client_id = ${clientId} AND endpoint <> ${endpoint}`
  if (count >= MAX_SUBSCRIPTIONS_PER_CLIENT) throw new HttpError(400, 'Notifications are already on for several devices.')
  await sql`
    INSERT INTO client_push_subscriptions (client_id, endpoint, p256dh, auth) VALUES (${clientId}, ${endpoint}, ${p256dh}, ${auth})
    ON CONFLICT (client_id, endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`
}

export async function listClientSubscriptions(clientId) {
  await ensureSchema()
  return db()`SELECT endpoint, p256dh, auth FROM client_push_subscriptions WHERE client_id = ${clientId}`
}

// With a clientId it removes only that client's device; without, the expired
// address is forgotten everywhere.
export async function deleteClientSubscription(endpoint, clientId = null) {
  await ensureSchema()
  if (clientId) await db()`DELETE FROM client_push_subscriptions WHERE endpoint = ${endpoint} AND client_id = ${clientId}`
  else await db()`DELETE FROM client_push_subscriptions WHERE endpoint = ${endpoint}`
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
    WHERE c.id = ${clientId} AND c.owner_id = ${ownerId} AND c.archived_at IS NULL
    ON CONFLICT (client_id, post_id) DO UPDATE SET
      snapshot = EXCLUDED.snapshot, status = 'waiting', feedback = NULL,
      decision_count = 0, note_saved = NULL, note_error = NULL, decided_at = NULL, edited_at = NULL
    RETURNING id`
  if (!rows.length) throw new HttpError(404, 'Client not found')
  await logShareEvent(rows[0].id, 'shared')
  return rows[0].id
}

// Records one line in the timeline, copying what the post said at that moment.
async function logShareEvent(shareId, kind, comment = null) {
  await db()`
    INSERT INTO events (client_id, share_id, kind, post_text, service, comment, snapshot)
    SELECT s.client_id, s.id, ${kind}, left(s.snapshot->>'text', 300), s.snapshot->>'service', ${comment}, s.snapshot
    FROM shares s WHERE s.id = ${shareId}`
}

export async function listSharesForOwner(ownerId) {
  await ensureSchema()
  return db()`
    SELECT s.id, s.post_id, s.snapshot, s.status, s.feedback, s.note_saved, s.decided_at, s.created_at, s.updated_at, s.edited_at,
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

// The post behind one of the manager's shares (owner-checked).
export async function getShareForOwner(ownerId, shareId) {
  await ensureSchema()
  const rows = await db()`
    SELECT s.id, s.post_id, s.status, s.client_id FROM shares s JOIN clients c ON c.id = s.client_id
    WHERE s.id = ${shareId} AND c.owner_id = ${ownerId}`
  return rows[0] || null
}

// The manager revised the post in Buffer: show the client the new version and
// ask again. The old answer is cleared; the optional note tells them what changed.
export async function refreshShare(ownerId, shareId, snapshot, note) {
  await ensureSchema()
  const rows = await db()`
    UPDATE shares s SET snapshot = ${JSON.stringify(snapshot)}::jsonb, status = 'waiting', feedback = NULL,
      decision_count = 0, note_saved = NULL, note_error = NULL, decided_at = NULL,
      manager_note = ${note || null}, updated_at = now(), edited_at = NULL
    FROM clients c
    WHERE s.id = ${shareId} AND s.client_id = c.id AND c.owner_id = ${ownerId}
    RETURNING s.id`
  if (!rows.length) throw new HttpError(404, 'Not found')
  await logShareEvent(rows[0].id, 'updated', note || null)
}

// What the client sees on their page: only posts that still need their answer.
// Once they approve or ask for changes, a post leaves their screen (the manager
// keeps the full record in History).
export async function listSharesForClient(clientId) {
  await ensureSchema()
  return db()`
    SELECT id, snapshot, manager_note, (updated_at IS NOT NULL) AS updated,
           COALESCE(updated_at, created_at) AS sent_at
    FROM shares WHERE client_id = ${clientId} AND status = 'waiting'
    ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 50`
}

// Used by automatic matching: never touches a share that already exists, so a
// client's earlier answer is never reset behind their back.
export async function createShareIfAbsent(clientId, postId, snapshot, source = 'auto') {
  await ensureSchema()
  const rows = await db()`
    INSERT INTO shares (client_id, post_id, snapshot, source)
    VALUES (${clientId}, ${postId}, ${JSON.stringify(snapshot)}::jsonb, ${source})
    ON CONFLICT (client_id, post_id) DO NOTHING RETURNING id`
  if (rows.length) await logShareEvent(rows[0].id, 'shared')
  return rows.length > 0
}

// What the app is currently showing clients, so it can be compared with Buffer.
export async function listShareIndex(ownerId) {
  await ensureSchema()
  return db()`
    SELECT s.id, s.post_id, s.status, s.snapshot FROM shares s JOIN clients c ON c.id = s.client_id
    WHERE c.owner_id = ${ownerId} AND c.archived_at IS NULL`
}

export async function updateShareSnapshot(shareId, snapshot) {
  await ensureSchema()
  await db()`UPDATE shares SET snapshot = ${JSON.stringify(snapshot)}::jsonb WHERE id = ${shareId}`
}

// Everything needed to decide which client a Buffer draft belongs to.
export async function listMatchData(ownerId) {
  await ensureSchema()
  const clients = await db()`SELECT id, name FROM clients WHERE owner_id = ${ownerId} AND archived_at IS NULL`
  const bodies = await db()`
    SELECT s.client_id, s.body FROM submissions s JOIN clients c ON c.id = s.client_id
    WHERE c.owner_id = ${ownerId} AND c.archived_at IS NULL AND s.status = 'sent'`
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

export async function getAutoShare(ownerId) {
  await ensureSchema()
  const rows = await db()`SELECT auto_share FROM owners WHERE account_id = ${ownerId}`
  return Boolean(rows[0]?.auto_share)
}

export async function setAutoShare(ownerId, value) {
  await ensureSchema()
  await db()`UPDATE owners SET auto_share = ${Boolean(value)} WHERE account_id = ${ownerId}`
}

// Remember which "changes requested" posts have since been edited in Buffer.
export async function markEdited(shareIds) {
  if (!shareIds.length) return
  await ensureSchema()
  await db()`UPDATE shares SET edited_at = COALESCE(edited_at, now()) WHERE id = ANY(${shareIds}::uuid[])`
}

export async function clearEdited(shareIds) {
  if (!shareIds.length) return
  await ensureSchema()
  await db()`UPDATE shares SET edited_at = NULL WHERE id = ANY(${shareIds}::uuid[])`
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
  await logShareEvent(shareId, status, feedback || null)
}

/* ------------------------------------------------ history and live updates */

// The manager's timeline, newest first. `kind` narrows it (approved, changes, ...).
export async function listEvents(ownerId, kind = null, limit = 200) {
  await ensureSchema()
  return db()`
    SELECT e.id, e.kind, e.post_text, e.service, e.comment, e.created_at, c.id AS client_id, c.name AS client_name
    FROM events e JOIN clients c ON c.id = e.client_id
    WHERE c.owner_id = ${ownerId} AND (${kind}::text IS NULL OR e.kind = ${kind})
    ORDER BY e.created_at DESC, e.id DESC LIMIT ${Math.min(Number(limit) || 200, 500)}`
}

// Has the manager ever shared a draft with this client? Until then the client's
// page opens with the full content form; from then on the form folds into a bar.
export async function clientEverShared(clientId) {
  await ensureSchema()
  const [{ yes }] = await db()`
    SELECT EXISTS (SELECT 1 FROM events WHERE client_id = ${clientId} AND kind = 'shared') AS yes`
  return yes
}

// A client's own History: what was sent to them, what they approved or asked
// about, and what they sent. Never the manager's internal reminders.
export async function listClientEvents(clientId, kind = null, limit = 200) {
  await ensureSchema()
  return db()`
    SELECT id, kind, post_text, service, comment, created_at FROM events
    WHERE client_id = ${clientId} AND kind <> 'nudged' AND (${kind}::text IS NULL OR kind = ${kind})
    ORDER BY created_at DESC, id DESC LIMIT ${Math.min(Number(limit) || 200, 500)}`
}

export async function getClientEvent(clientId, eventId) {
  await ensureSchema()
  const rows = await db()`
    SELECT id, kind, post_text, service, comment, snapshot, created_at FROM events
    WHERE id = ${eventId} AND client_id = ${clientId} AND kind <> 'nudged'`
  return rows[0] || null
}

// One entry in full, with the post as it was at that moment (owner-checked).
export async function getEvent(ownerId, eventId) {
  await ensureSchema()
  const rows = await db()`
    SELECT e.id, e.kind, e.post_text, e.service, e.comment, e.snapshot, e.created_at, c.name AS client_name
    FROM events e JOIN clients c ON c.id = e.client_id
    WHERE e.id = ${eventId} AND c.owner_id = ${ownerId}`
  return rows[0] || null
}

// A tiny fingerprint of "what is on screen". Pages ask for it every few seconds
// and only reload the full view when it changes, so updates appear on their own
// without refreshing and without heavy requests.
export async function pulseForOwner(ownerId) {
  await ensureSchema()
  const [r] = await db()`
    SELECT
      (SELECT coalesce(max(e.id), 0) FROM events e JOIN clients c ON c.id = e.client_id WHERE c.owner_id = ${ownerId}) AS e,
      (SELECT count(*) FROM clients WHERE owner_id = ${ownerId} AND archived_at IS NULL) AS c,
      (SELECT count(*) FROM clients WHERE owner_id = ${ownerId} AND archived_at IS NOT NULL) AS a,
      (SELECT count(*) FROM shares s JOIN clients c ON c.id = s.client_id WHERE c.owner_id = ${ownerId}) AS s,
      -- moves when a client opens their link or is reminded, so those show up live too
      (SELECT coalesce(max(extract(epoch FROM greatest(last_opened_at, last_nudged_at)))::bigint, 0)
         FROM clients WHERE owner_id = ${ownerId} AND archived_at IS NULL) AS o`
  return `${r.e}.${r.c}.${r.a}.${r.s}.${r.o}`
}

export async function pulseForClient(clientId) {
  await ensureSchema()
  const [r] = await db()`
    SELECT (SELECT coalesce(max(id), 0) FROM events WHERE client_id = ${clientId}) AS e,
           (SELECT count(*) FROM shares WHERE client_id = ${clientId}) AS s`
  return `${r.e}.${r.s}`
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
  if (!error) {
    await db()`
      INSERT INTO events (client_id, kind, post_text, comment, snapshot)
      SELECT client_id, 'submitted', left(title, 300), left(body, 300),
             jsonb_build_object('title', title, 'text', body, 'details', details, 'timing', timing_note,
                                'date', preferred_date, 'photos', photos)
      FROM submissions WHERE id = ${id}`
  }
}
