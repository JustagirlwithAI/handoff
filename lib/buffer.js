import crypto from 'node:crypto'
import {
  API_URL,
  AUTH_URL,
  CLIENT_ID,
  CLIENT_SECRET,
  HttpError,
  REDIRECT_URI,
  SCOPES,
  TOKEN_URL,
  withCause,
} from './config.js'
import { claimRefresh, deleteOwner, getOwner, releaseRefresh, saveOwner } from './db.js'

/* ------------------------------------------------------------- oauth flow */

// The verifier is the secret. Its SHA-256 digest is the challenge, and only the
// challenge is ever sent to Buffer — the verifier stays on this server until
// the token exchange, which is what makes a stolen authorization code useless.
export function createPkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

// Random value echoed back by Buffer on the callback. If it doesn't match what
// we handed out, the callback didn't come from a flow we started.
export function createState() {
  return crypto.randomBytes(16).toString('base64url')
}

export function buildAuthorizeUrl({ state, codeChallenge }) {
  const url = new URL(AUTH_URL)
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',          // selects the Authorization Code flow
    scope: SCOPES,                  // space-separated
    state,
    code_challenge: codeChallenge,  // the hash — never the verifier
    code_challenge_method: 'S256',  // tells Buffer the challenge is a SHA-256 hash
    prompt: 'consent',
  }).toString()
  return url.toString()
}

// What the token endpoint's error codes usually mean in practice. Naming the
// likely cause saves the reader a trip through the OAuth spec.
const TOKEN_ERROR_HINTS = {
  invalid_client: 'set BUFFER_CLIENT_SECRET for a confidential client, or omit it entirely for a public one',
  invalid_grant: 'the code was already used or has expired, or redirect_uri differs from the authorize request',
  invalid_scope: 'a requested scope is not enabled on this app client',
  unsupported_grant_type: 'this client is not allowed to use that grant type',
}

// The authorization server advertises only "none" and "client_secret_post", so
// the secret always goes in the form body — never HTTP Basic.
export async function requestTokens(params, previous = null) {
  const body = new URLSearchParams({ client_id: CLIENT_ID, ...params })
  if (CLIENT_SECRET) body.set('client_secret', CLIENT_SECRET)

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const json = await res.json().catch(() => ({}))

  if (!res.ok || json.error) {
    const detail = json.error_description || json.error || `HTTP ${res.status}`
    const hint = TOKEN_ERROR_HINTS[json.error]
    const error = new Error(hint ? `${detail} — ${hint}` : detail)
    error.oauthError = json.error
    throw error
  }

  return {
    accessToken: json.access_token,
    // Buffer replaces a refresh token when it is used. Never retain the old
    // value after a successful refresh.
    refreshToken: json.refresh_token || null,
    scope: json.scope || previous?.scope,
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000 - 30_000,
    connectedAt: previous?.connectedAt || Date.now(),
  }
}

// Trade the one-time code for tokens. This is where the code_verifier is
// finally revealed: Buffer re-hashes it, compares it to the challenge from the
// authorize step, and only trusts us if they match.
export async function exchangeCodeForTokens({ code, codeVerifier }) {
  const tokens = await requestTokens({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,   // must byte-match the authorize request
    code_verifier: codeVerifier,
  })
  if (!tokens.refreshToken) throw new Error('Buffer did not return a refresh token; enable offline_access for this app client')
  return tokens
}

export async function refreshTokens(previous) {
  const replacement = await requestTokens({
    grant_type: 'refresh_token',
    refresh_token: previous.refreshToken,
  }, previous)

  // A replacement is required for a rotating-token flow. Continuing with the
  // old token would make a later failure hard to diagnose and unsafe to retry.
  if (!replacement.refreshToken) throw new Error('Buffer did not return a replacement refresh token')
  return replacement
}

// The gate every API call passes through. It saves a rotated token pair before
// returning, so the next request uses Buffer's replacement refresh token.
//
// Handoff keeps the manager's Buffer connection in the database (encrypted), not
// in the browser, because clients who are not signed in need the app to act for
// the manager. `ctx.ownerId` says whose connection to use.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function accessToken(ctx) {
  // Right after sign-in there is nothing stored yet: the callback passes the
  // brand-new token directly to find out whose account it is.
  if (ctx.token) return ctx.token
  const ownerId = ctx.ownerId
  if (!ownerId) throw new HttpError(401, 'Not connected to Buffer')

  let owner = await getOwner(ownerId)
  if (!owner) throw new HttpError(401, 'Not connected to Buffer')
  if (Date.now() < owner.expiresAt) return owner.accessToken

  // Expired. Buffer refresh tokens are single-use, so only one request may renew
  // at a time. Whoever wins the claim renews; everyone else waits for the result.
  for (let attempt = 0; attempt < 12; attempt++) {
    const claimed = await claimRefresh(ownerId)
    if (claimed) {
      try {
        const renewed = await refreshTokens(claimed)
        await saveOwner(ownerId, renewed)
        return renewed.accessToken
      } catch (err) {
        console.warn(JSON.stringify({ event: 'buffer_token_refresh_failed', code: err.oauthError }))
        if (err.oauthError) {
          // Buffer refused the token: the connection is over until they sign in again.
          await deleteOwner(ownerId)
          throw new HttpError(401, 'The Buffer connection expired. The account owner needs to sign in again.')
        }
        await releaseRefresh(ownerId) // a network blip: let someone try again
        throw new HttpError(502, 'Could not reach Buffer. Please try again.')
      }
    }
    await sleep(500)
    owner = await getOwner(ownerId)
    if (!owner) throw new HttpError(401, 'Not connected to Buffer')
    if (Date.now() < owner.expiresAt) return owner.accessToken
  }
  throw new HttpError(503, 'Buffer is busy. Please try again in a moment.')
}

/* --------------------------------------------------------------- graphql */
// Everything the app reads or writes goes through one GraphQL endpoint at
// https://api.buffer.com, with the access token in an Authorization header.

// Rate limits are per client, so every user of this app shares one quota. A
// well-behaved client reads Retry-After and backs off rather than hammering.
const MAX_BACKOFF_SECONDS = 5

export async function graphql(ctx, query, variables, { backedOff = false } = {}) {
  const token = await accessToken(ctx)
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  const json = await res.json().catch(() => null)

  if (res.status === 401) {
    // Buffer no longer accepts this connection (for instance the manager revoked
    // access in Buffer's settings). Forget it so they are asked to sign in again.
    if (ctx.ownerId) await deleteOwner(ctx.ownerId)
    throw new HttpError(401, 'Buffer rejected the connection. The account owner needs to sign in again.')
  }

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After')) || 0
    // Wait out a short reset once. A long one is not worth holding a request
    // open for — serverless functions bill wall-clock time and time out — so
    // it is reported instead, with the wait the API asked for.
    if (!backedOff && retryAfter > 0 && retryAfter <= MAX_BACKOFF_SECONDS) {
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000))
      return graphql(ctx, query, variables, { backedOff: true })
    }
    throw new HttpError(429, `Buffer API rate limit reached${retryAfter ? ` — try again in ${retryAfter}s` : ''}`)
  }

  // A GraphQL request that fails still comes back as HTTP 200. The real status
  // is in the `errors` array, under extensions.code.
  if (!res.ok || json?.errors?.length) {
    const failure = json?.errors?.[0]
    const code = failure?.extensions?.code
    console.error(JSON.stringify({ event: 'buffer_api_error', status: res.status, code, message: failure?.message }))
    throw new HttpError(502, withCause(
      'Buffer could not complete the request. Please try again.',
      [code, failure?.message].filter(Boolean).join(': ') || `HTTP ${res.status}`,
    ))
  }
  return json.data
}

export const ACCOUNT_QUERY = `
  query Account {
    account {
      id
      email
      name
      organizations { id name }
    }
  }
`

// A "channel" is any social account connected to Buffer — a LinkedIn profile,
// an Instagram account, and so on. We scope the query to one organization.
export const CHANNELS_QUERY = `
  query Channels($organizationId: OrganizationId!) {
    channels(input: { organizationId: $organizationId }) {
      id
      name
      displayName
      service
      avatar
      isDisconnected
      isQueuePaused
    }
  }
`

// createPost returns a UNION: either PostActionSuccess or one of several typed
// error types. MutationError is the interface all of those errors implement, so
// a single `... on MutationError` block catches every one of them, and a failed
// operation arrives as data you can show the user rather than as an exception.
export const CREATE_POST = `
  mutation CreatePost($input: CreatePostInput!) {
    createPost(input: $input) {
      ... on PostActionSuccess {
        post { id text status dueAt channelId }
      }
      ... on MutationError { message }
    }
  }
`

// EXPERIMENTAL (Day 1 test): a Note is a comment attached to a post. Handoff
// wants to save client feedback this way. It may not work on the Free plan.
export const CREATE_NOTE = `
  mutation CreateNote($input: CreateCollaborationNoteInput!) {
    createCollaborationNote(input: $input) {
      __typename
      ... on CreateCollaborationNoteSuccess {
        edge { node { id text } }
      }
      ... on MutationError { message }
    }
  }
`

// Networks do not all accept the same post. These are the metadata fields the
// schema marks non-null for a service, so a post to that service fails
// validation without them. Every other service needs no metadata at all.
const REQUIRED_METADATA = {
  instagram: { type: 'post', shouldShareToFeed: true },
  facebook: { type: 'post' },
  googlebusiness: { type: 'whats_new' },
}

// PostInputMetaData calls Google Business Profile `google`; every other service
// uses the same name the channel reports.
const METADATA_FIELD = { googlebusiness: 'google' }

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm']

// One hosted URL becomes one asset. Whether it is an image or a video changes
// how the networks treat it, and the extension is all there is to go on.
function assetsFor(mediaUrl) {
  if (!mediaUrl) return []
  const path = new URL(mediaUrl).pathname.toLowerCase()
  const isVideo = VIDEO_EXTENSIONS.some((extension) => path.endsWith(extension))
  return [isVideo ? { video: { url: mediaUrl } } : { image: { url: mediaUrl } }]
}

// Assembles CreatePostInput. Two of its required fields are easy to miss:
// `assets` and `needsApproval` are non-null in the schema, so the mutation
// fails validation without them even when there is nothing to put there.
export function buildPostInput({ channelId, service, text, mediaUrl }) {
  const input = {
    channelId,
    text,
    assets: assetsFor(mediaUrl),
    needsApproval: false,
    mode: 'addToQueue',      // next free slot in the channel's queue
    schedulingType: 'automatic',
    saveToDraft: true,       // keeps it a draft; drop it to publish for real
  }

  const fields = { ...REQUIRED_METADATA[service] }
  // YouTube shows a title rather than the caption, so it gets the first line.
  if (service === 'youtube') fields.title = text.split('\n')[0].slice(0, 100)

  if (Object.keys(fields).length) {
    input.metadata = { [METADATA_FIELD[service] || service]: fields }
  }

  return input
}
