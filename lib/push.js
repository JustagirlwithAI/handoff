import * as webpush from 'web-push'
import { PUBLIC_BASE_URL } from './config.js'
import { decrypt, encrypt } from './crypto.js'
import {
  deleteClientSubscription, deleteSubscription, getSetting, listClientSubscriptions, listSubscriptions, setSettingIfAbsent,
} from './db.js'

/* ------------------------------------------------------------------ keys */
// Web push needs a pair of keys that identify this app to the browser makers'
// push services. Handoff makes its own the first time it needs them and keeps
// them in the database (the private half encrypted), so there is nothing to set up.

let cached = null

async function vapidKeys() {
  if (cached) return cached
  let stored = await getSetting('vapid')
  if (!stored) {
    const made = webpush.generateVAPIDKeys()
    await setSettingIfAbsent('vapid', JSON.stringify({ publicKey: made.publicKey, privateKey: encrypt(made.privateKey) }))
    stored = await getSetting('vapid') // whichever writer won
  }
  const parsed = JSON.parse(stored)
  const privateKey = decrypt(parsed.privateKey)
  if (!privateKey) throw new Error('Stored notification keys cannot be read (was SESSION_SECRET changed?)')
  cached = { publicKey: parsed.publicKey, privateKey }
  return cached
}

export async function publicKey() {
  return (await vapidKeys()).publicKey
}

/* ------------------------------------------------------------ safety rule */
// The server will POST to the address a browser hands it. Without a check, a
// signed-in user could make the server contact any website they like. So only
// the real push services of the major browsers are allowed.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /\.push\.services\.mozilla\.com$/,
  /\.notify\.windows\.com$/,
  /^web\.push\.apple\.com$/,
  /\.push\.apple\.com$/,
]

export function isAllowedEndpoint(value) {
  if (typeof value !== 'string' || value.length > 1000) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && PUSH_HOSTS.some((re) => re.test(url.hostname))
  } catch {
    return false
  }
}

/* --------------------------------------------------------------- messages */

const clip = (text, max) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function decisionMessage(clientName, decision, comment, postText) {
  if (decision === 'approved') {
    return {
      title: `${clientName} approved a post`,
      body: clip(comment || postText, 120) || 'Ready to schedule.',
      tag: 'handoff-decision',
    }
  }
  return {
    title: `${clientName} requested changes`,
    body: clip(comment, 120) || 'Open Buffer to see their note.',
    tag: 'handoff-decision',
  }
}

// What a client sees when their manager shares a post, or sends a revised one.
export function reviewMessage(updated, postText) {
  return {
    title: updated ? 'An updated post is ready for you' : 'A new post is ready for your approval',
    body: clip(postText, 120) || 'Open your page to take a look.',
    tag: 'handoff-review',
  }
}

export function submissionMessage(clientName, title) {
  return { title: `${clientName} sent new content`, body: clip(title, 120), tag: 'handoff-content' }
}

/* ---------------------------------------------------------------- sending */

async function defaultSend(subscription, payload) {
  const keys = await vapidKeys()
  return webpush.sendNotification(subscription, JSON.stringify(payload), {
    TTL: 24 * 60 * 60,
    vapidDetails: { subject: PUBLIC_BASE_URL || 'https://handoff-nine-lemon.vercel.app', publicKey: keys.publicKey, privateKey: keys.privateKey },
  })
}

// Sends one notification to every device the manager turned notifications on for.
// Never throws: a notification is a courtesy, and must not break the action that
// caused it. Devices whose subscription has expired are forgotten automatically.
export function notifyOwner(ownerId, message, options) {
  return deliver(() => listSubscriptions(ownerId), (endpoint) => deleteSubscription(endpoint), { ...message, kind: 'manager' }, options)
}

// The same, for the devices a client turned notifications on for.
export function notifyClient(clientId, message, options) {
  return deliver(() => listClientSubscriptions(clientId), (endpoint) => deleteClientSubscription(endpoint, clientId), { ...message, kind: 'client' }, options)
}

async function deliver(listSubs, forget, message, { send = defaultSend, timeoutMs = 6000 } = {}) {
  try {
    const subs = await listSubs()
    if (!subs.length) return { sent: 0, failed: 0 }
    const payload = { ...message, url: message.url || '/' }

    const work = Promise.allSettled(subs.map(async (sub) => {
      try {
        await send({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload)
        return true
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) await forget(sub.endpoint)
        else console.warn(JSON.stringify({ event: 'push_failed', status: err.statusCode, message: String(err.message).slice(0, 120) }))
        return false
      }
    }))
    // Serverless hosts may freeze the function once the response is sent, so wait
    // for the pushes, but not forever.
    const results = await Promise.race([work, new Promise((resolve) => setTimeout(() => resolve([]), timeoutMs))])
    const sent = results.filter((r) => r.status === 'fulfilled' && r.value).length
    return { sent, failed: subs.length - sent }
  } catch (err) {
    console.warn(JSON.stringify({ event: 'push_error', message: String(err.message).slice(0, 160) }))
    return { sent: 0, failed: 0 }
  }
}
