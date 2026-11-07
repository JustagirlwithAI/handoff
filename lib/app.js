import express from 'express'
import path from 'node:path'
import { BEHIND_PROXY, HttpError, PHOTOS_ENABLED, PUBLIC_BASE_URL, REDIRECT_URI, loginUnavailableReason, withCause } from './config.js'
import {
  MAX_DECISIONS_PER_SHARE, createClient, createShare, createSubmission, deleteClient, deleteShare,
  deleteSubscription, finishSubmission, findClientByToken, getOwner, getShareForClient, getShareForOwner, refreshShare, saveSubscription, listClients, listSharesForClient,
  listSharesForOwner, recentSubmissionCount, recordDecision, renewClientLink, saveOwner,
} from './db.js'
import { decisionMessage, isAllowedEndpoint, notifyOwner, publicKey, submissionMessage } from './push.js'
import { listDrafts, ownerOrganization, saveDecisionNote, saveUpdateNote, snapshotForSharing, syncAutoShares } from './approvals.js'
import { isOwnPhotoUrl, signUpload } from './cloudinary.js'
import { createIdeaForClient } from './ideas.js'
import { readSession } from './session.js'
import {
  ACCOUNT_QUERY,
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  exchangeCodeForTokens,
  graphql,
} from './buffer.js'

const app = express()
if (BEHIND_PROXY) app.set('trust proxy', 1)
app.use(express.json())

// Every route gets the session up front; routes that change it save explicitly.
app.use(async (req, res, next) => {
  try {
    req.session = await readSession(req, res)
    req.ctx = { req, res, session: req.session, ownerId: req.session.accountId }
    next()
  } catch (err) {
    next(err)
  }
})

app.use(express.static(path.join(import.meta.dirname, '..', 'public')))

// Account data and authentication cookies must never be stored by a shared cache.
app.use(['/api', '/auth', '/callback'], (_req, res, next) => {
  res.set('Cache-Control', 'no-store, private')
  next()
})

// Lets a route throw HttpError and have it become a real response.
const wrap = (handler) => async (req, res, next) => {
  try {
    await handler(req, res)
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    next(err)
  }
}

app.get('/auth/login', wrap(async (req, res) => {
  const unavailable = loginUnavailableReason(req.get('host'))
  if (unavailable) return res.redirect(`/?error=${encodeURIComponent(unavailable)}`)

  const { verifier, challenge } = createPkcePair()
  const state = createState()

  // Note the asymmetry: we keep the verifier and the state, and send out only
  // the challenge (the hash) and the state.
  req.session.pkce = { codeVerifier: verifier, state }
  await req.session.save()

  res.redirect(buildAuthorizeUrl({ state, codeChallenge: challenge }))
}))

app.get('/callback', wrap(async (req, res) => {
  const { code, state, error, error_description: description } = req.query
  const pkce = req.session.pkce
  req.session.pkce = null   // one-time values — discard either way

  if (error) {
    await req.session.save()
    return res.redirect(`/?error=${encodeURIComponent(description || error)}`)
  }
  // CSRF check: only a callback this app started carries the state we stored.
  // A missing session and a mismatched state have different causes, so they get
  // different messages.
  if (!pkce) {
    await req.session.save()
    return res.status(403).send(
      'Session lost: this callback carries no record of the login that started it. ' +
        'Usually the server restarted between Connect and coming back here (a SESSION_SECRET that changes ' +
        'invalidates every session cookie), or the flow started on a different origin than ' +
        `${REDIRECT_URI} — localhost and 127.0.0.1 are separate cookie origins. Start again from the connect screen.`,
    )
  }
  if (state !== pkce.state) {
    await req.session.save()
    return res.status(403).send('Invalid state parameter: this callback did not come from a login this app started.')
  }

  let tokens
  try {
    // The code is short-lived, so exchange it immediately.
    tokens = await exchangeCodeForTokens({ code, codeVerifier: pkce.codeVerifier })
  } catch (err) {
    console.error(JSON.stringify({ event: 'oauth_token_exchange_failed', code: err.oauthError, message: err.message }))
    await req.session.save()
    const message = withCause('Buffer could not complete the connection. Check your client configuration.', err.message)
    return res.redirect(`/?error=${encodeURIComponent(message)}`)
  }

  try {
    // Find out whose Buffer account this is, then keep the connection (encrypted)
    // in the database. The browser cookie only remembers WHICH account, never
    // the tokens themselves.
    const { account } = await graphql({ token: tokens.accessToken }, ACCOUNT_QUERY)
    await saveOwner(account.id, tokens)
    req.session.accountId = account.id
    await req.session.save()
  } catch (err) {
    console.error(JSON.stringify({ event: 'connection_save_failed', message: err.message }))
    await req.session.save()
    return res.redirect(`/?error=${encodeURIComponent(withCause('Connected to Buffer, but Handoff could not save the connection.', err.message))}`)
  }
  res.redirect('/')
}))

app.post('/auth/logout', wrap(async (req, res) => {
  await req.session.destroy()
  res.json({ connected: false })
}))

app.get('/api/session', wrap(async (req, res) => {
  // redirectUri is echoed back for debugging: curl this endpoint to see the
  // exact callback the app will send, rather than guessing from Buffer's
  // generic error page.
  const owner = req.session.accountId ? await getOwner(req.session.accountId) : null
  if (!owner) return res.json({ connected: false, redirectUri: REDIRECT_URI })

  const data = await graphql(req.ctx, ACCOUNT_QUERY)
  const { scope, connectedAt } = owner
  res.json({
    connected: true,
    account: data.account,
    scope,
    redirectUri: REDIRECT_URI,
    connectedAt,
  })
}))

/* ------------------------------------------------ clients (manager side) */
// These routes need Buffer sign-in. Every query is filtered by the signed-in
// account's id, so a manager can only ever see or change their own clients.

function ownerId(ctx) {
  if (!ctx.session.accountId) throw new HttpError(401, 'Not connected to Buffer')
  return ctx.session.accountId
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function linkFor(req, token) {
  return `${PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`}/c/${token}`
}

function clientId(req) {
  if (!UUID.test(req.params.id)) throw new HttpError(404, 'Client not found')
  return req.params.id
}

app.get('/api/clients', wrap(async (req, res) => {
  res.json({ clients: await listClients(await ownerId(req.ctx)) })
}))

app.post('/api/clients', wrap(async (req, res) => {
  const owner = await ownerId(req.ctx)
  const name = String(req.body?.name ?? '').trim()
  if (!name) throw new HttpError(400, 'Give the client a name')
  if (name.length > 80) throw new HttpError(400, 'Client names can be up to 80 characters')
  const { client, token } = await createClient(owner, name)
  // The link is shown once, here. Only its fingerprint is stored.
  res.status(201).json({ client, link: linkFor(req, token) })
}))

app.post('/api/clients/:id/link', wrap(async (req, res) => {
  const { client, token } = await renewClientLink(await ownerId(req.ctx), clientId(req))
  res.json({ client, link: linkFor(req, token) })
}))

app.delete('/api/clients/:id', wrap(async (req, res) => {
  await deleteClient(await ownerId(req.ctx), clientId(req))
  res.json({ deleted: true })
}))

/* ----------------------------------------- notifications (manager side) */

app.get('/api/push/key', wrap(async (req, res) => {
  ownerId(req.ctx)
  res.json({ publicKey: await publicKey() })
}))

// Remembers one browser or phone so it can be notified later.
app.post('/api/push/subscribe', wrap(async (req, res) => {
  const owner = ownerId(req.ctx)
  const { endpoint, keys } = req.body || {}
  if (!isAllowedEndpoint(endpoint)) throw new HttpError(400, 'This browser\'s notification address is not supported.')
  if (typeof keys?.p256dh !== 'string' || typeof keys?.auth !== 'string' || keys.p256dh.length > 200 || keys.auth.length > 100) {
    throw new HttpError(400, 'Invalid notification keys.')
  }
  await saveSubscription(owner, { endpoint, p256dh: keys.p256dh, auth: keys.auth })
  res.status(201).json({ subscribed: true })
}))

app.post('/api/push/unsubscribe', wrap(async (req, res) => {
  const owner = ownerId(req.ctx)
  if (typeof req.body?.endpoint === 'string') await deleteSubscription(req.body.endpoint, owner)
  res.json({ unsubscribed: true })
}))

// Lets the manager check that notifications really arrive.
app.post('/api/push/test', wrap(async (req, res) => {
  const owner = ownerId(req.ctx)
  const result = await notifyOwner(owner, { title: 'Handoff notifications are on', body: 'You will see client approvals and requests here.', tag: 'handoff-test' })
  res.json(result)
}))

/* ---------------------------------------------- approvals (manager side) */

// Draft posts in Buffer that could be shared with a client by hand.
app.get('/api/drafts', wrap(async (req, res) => {
  const owner = ownerId(req.ctx)
  res.json({ drafts: await listDrafts(req.ctx, await ownerOrganization(req.ctx, owner)) })
}))

// Share one draft with one client. The server re-reads the post from Buffer
// instead of trusting anything the browser says about it.
app.post('/api/clients/:id/shares', wrap(async (req, res) => {
  const owner = ownerId(req.ctx)
  const postId = String(req.body?.postId ?? '').trim()
  if (!/^[A-Za-z0-9]{10,40}$/.test(postId)) throw new HttpError(400, 'Choose a draft to share')
  const snapshot = await snapshotForSharing(req.ctx, postId)
  const shareId = await createShare(owner, clientId(req), postId, snapshot)
  res.status(201).json({ shareId })
}))

// The whole dashboard in one request: every client, with the status of each post
// shared with them. It first looks for new drafts that belong to a client.
app.get('/api/overview', wrap(async (req, res) => {
  const owner = ownerId(req.ctx)
  await syncAutoShares(owner)
  const [clients, shares] = await Promise.all([listClients(owner), listSharesForOwner(owner)])
  res.json({
    clients: clients.map((c) => {
      const mine = shares.filter((s) => s.client_id === c.id)
      return {
        id: c.id,
        name: c.name,
        counts: {
          waiting: mine.filter((s) => s.status === 'waiting').length,
          approved: mine.filter((s) => s.status === 'approved').length,
          changes: mine.filter((s) => s.status === 'changes').length,
        },
        shares: mine.map((s) => ({
          id: s.id, postId: s.post_id, status: s.status, feedback: s.feedback, noteSaved: s.note_saved,
          decidedAt: s.decided_at, text: s.snapshot.text, channel: s.snapshot.channel, service: s.snapshot.service,
        })),
      }
    }),
  })
}))

// The manager revised the post in Buffer: show the client the new version and
// ask them again. An optional one-line note says what changed.
app.post('/api/shares/:id/refresh', wrap(async (req, res) => {
  const owner = ownerId(req.ctx)
  if (!UUID.test(req.params.id)) throw new HttpError(404, 'Not found')
  const share = await getShareForOwner(owner, req.params.id)
  if (!share) throw new HttpError(404, 'Not found')
  const note = text(req.body?.note, 300)

  // Re-read the post from Buffer, so the client sees exactly what Buffer has now.
  const snapshot = await snapshotForSharing(req.ctx, share.post_id, { allowScheduled: true })
  await refreshShare(owner, share.id, snapshot, note)
  const traced = await saveUpdateNote(req.ctx, share.post_id, note)
  res.json({ refreshed: true, noteSaved: traced })
}))

app.delete('/api/shares/:id', wrap(async (req, res) => {
  if (!UUID.test(req.params.id)) throw new HttpError(404, 'Not found')
  await deleteShare(ownerId(req.ctx), req.params.id)
  res.json({ deleted: true })
}))

/* ------------------------------------------------- clients (no login) */
// Anyone holding a valid private link can use these. They never touch the
// manager's Buffer session, and they only ever see the one client the link names.

// Keep private links out of search engines and out of Referer headers.
app.use(['/c', '/api/public'], (_req, res, next) => {
  res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' })
  next()
})

// A small speed limit against link guessing. It lives in memory, so on a
// serverless host each instance counts separately: a brake, not a wall. The real
// protection is that links hold 256 bits of randomness.
const hits = new Map()
function publicRateLimit(req, res, next) {
  const now = Date.now()
  const key = req.ip
  const recent = (hits.get(key) || []).filter((t) => now - t < 60_000)
  recent.push(now)
  hits.set(key, recent)
  if (hits.size > 5000) hits.clear()
  if (recent.length > 60) return res.status(429).json({ error: 'Too many requests. Please wait a minute.' })
  next()
}

app.get('/c/:token', (_req, res) => {
  res.set('Cache-Control', 'no-store, private')
  res.sendFile(path.join(import.meta.dirname, '..', 'public', 'client.html'))
})

app.get('/api/public/:token', publicRateLimit, wrap(async (req, res) => {
  const client = await findClientByToken(req.params.token)
  // One generic answer for "wrong", "expired" and "replaced": no hints for guessers.
  if (!client) throw new HttpError(404, 'This link is not valid. Ask your social media manager for a new one.')
  res.json({ client: { name: client.name }, photosEnabled: PHOTOS_ENABLED })
}))

async function clientFromLink(req) {
  const client = await findClientByToken(req.params.token)
  if (!client) throw new HttpError(404, 'This link is not valid. Ask your social media manager for a new one.')
  return client
}

// Signs one photo upload for this client (see lib/cloudinary.js).
app.post('/api/public/:token/upload-signature', publicRateLimit, wrap(async (req, res) => {
  const client = await clientFromLink(req)
  const signed = signUpload(client.id)
  if (!signed) throw new HttpError(503, 'Photo uploads are not available right now.')
  res.json(signed)
}))

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
const MAX_SUBMISSIONS_PER_DAY = 20

app.post('/api/public/:token/submissions', publicRateLimit, wrap(async (req, res) => {
  const client = await clientFromLink(req)
  const body = req.body || {}

  const submission = {
    title: text(body.title, 100),
    text: text(body.text, 2000),
    details: text(body.details, 1000),
    timing: text(body.timing, 200),
    date: '',
    photos: [],
  }
  if (!submission.title) throw new HttpError(400, 'Please add a short title.')
  if (!submission.text) throw new HttpError(400, 'Please write the post text.')

  if (body.date) {
    const date = text(body.date, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new HttpError(400, 'That date does not look right.')
    submission.date = date
  }

  if (body.photos !== undefined) {
    if (!Array.isArray(body.photos) || body.photos.length > 4) throw new HttpError(400, 'You can add up to 4 photos.')
    if (!body.photos.every((url) => isOwnPhotoUrl(url, client.id))) throw new HttpError(400, 'One of the photos could not be used. Please upload it again.')
    submission.photos = body.photos
  }

  if ((await recentSubmissionCount(client.id)) >= MAX_SUBMISSIONS_PER_DAY) {
    throw new HttpError(429, 'You have sent a lot today. Please try again tomorrow.')
  }

  // Save first, so nothing a client wrote is ever lost, even if Buffer is down.
  const submissionId = await createSubmission(client.id, submission)
  try {
    const { ideaId, tagged } = await createIdeaForClient({ ownerId: client.owner_id }, client, submission)
    await finishSubmission(submissionId, { ideaId })
    await notifyOwner(client.owner_id, submissionMessage(client.name, submission.title))
    res.status(201).json({ sent: true, tagged })
  } catch (err) {
    console.error(JSON.stringify({ event: 'idea_creation_failed', submissionId, message: err.message }))
    await finishSubmission(submissionId, { error: String(err.message).slice(0, 500) })
    // Clients see a calm, generic message. The details stay in our logs/database.
    throw new HttpError(502, 'We saved your message, but could not pass it to your manager just yet. They have been notified to check.')
  }
}))

// The drafts shared with this client. Served from our own copy, so no call to Buffer.
app.get('/api/public/:token/shares', publicRateLimit, wrap(async (req, res) => {
  const client = await clientFromLink(req)
  await syncAutoShares(client.owner_id) // picks up drafts the manager just made (at most once a minute)
  const shares = await listSharesForClient(client.id)
  res.json({
    shares: shares.map((s) => ({
      id: s.id, status: s.status, feedback: s.feedback, managerNote: s.manager_note, updated: s.updated, decidedAt: s.decided_at, post: s.snapshot,
    })),
  })
}))

// The client approves, or asks for changes. The answer is saved in our database
// first, then written to the post in Buffer as a Note.
app.post('/api/public/:token/shares/:shareId/decision', publicRateLimit, wrap(async (req, res) => {
  const client = await clientFromLink(req)
  if (!UUID.test(req.params.shareId)) throw new HttpError(404, 'Not found')
  const share = await getShareForClient(client.id, req.params.shareId)
  if (!share) throw new HttpError(404, 'Not found')

  const decision = req.body?.decision
  if (!['approved', 'changes'].includes(decision)) throw new HttpError(400, 'Choose Approve or Request changes.')
  const comment = text(req.body?.comment, 1000)
  if (decision === 'changes' && !comment) throw new HttpError(400, 'Please tell us what to change.')
  // A brake on Buffer Notes: the app shares one Buffer quota across everyone.
  if (share.decision_count >= MAX_DECISIONS_PER_SHARE) throw new HttpError(429, 'This post has been updated many times. Please message your manager directly.')

  const note = await saveDecisionNote({ ownerId: client.owner_id }, share.post_id, client.name, decision, comment)
  if (!note.saved) console.warn(JSON.stringify({ event: 'note_not_saved', shareId: share.id, error: note.error }))
  await recordDecision(share.id, { status: decision, feedback: comment, noteSaved: note.saved, noteError: note.error })
  await notifyOwner(client.owner_id, decisionMessage(client.name, decision, comment, share.snapshot?.text))
  res.json({ status: decision })
}))

// Misconfiguration (a missing SESSION_SECRET, for instance) should read as a
// clear message instead of an opaque platform 500.
app.use((err, _req, res, next) => {
  // Too late for a clean response; let Express close the connection.
  if (res.headersSent) return next(err)
  console.error(JSON.stringify({ event: 'unhandled_request_error', name: err.name, message: err.message }))
  res.status(500).json({ error: withCause('Something went wrong. Please try again.', err.message) })
})

export default app
