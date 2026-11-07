import assert from 'node:assert/strict'
import test from 'node:test'

process.env.BUFFER_CLIENT_ID ||= 'test-client'
const { DATABASE_URL } = await import('../lib/config.js')
const { isAllowedEndpoint, decisionMessage, submissionMessage, notifyOwner, publicKey } = await import('../lib/push.js')
const db = await import('../lib/db.js')

test('only real browser push services are accepted as notification addresses', () => {
  const good = [
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
    'https://web.push.apple.com/abc',
  ]
  const bad = [
    'https://evil.example/fcm.googleapis.com',
    'https://fcm.googleapis.com.evil.example/x',
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://user:pass@fcm.googleapis.com/x',
    'https://169.254.169.254/latest/meta-data',
    'https://localhost/x',
    'not a url', '', null, undefined, 42,
  ]
  for (const url of good) assert.equal(isAllowedEndpoint(url), true, url)
  for (const url of bad) assert.equal(isAllowedEndpoint(url), false, String(url))
})

test('notification messages are short and say what happened', () => {
  assert.deepEqual(decisionMessage('Sunrise Bakery', 'approved', '', 'Fresh bread today').title, 'Sunrise Bakery approved a post')
  const changes = decisionMessage('Sunrise Bakery', 'changes', 'Shorten the caption', 'x')
  assert.equal(changes.title, 'Sunrise Bakery requested changes')
  assert.equal(changes.body, 'Shorten the caption')
  assert.equal(decisionMessage('A', 'changes', 'x'.repeat(500), '').body.length, 120)
  assert.equal(submissionMessage('Green Studio', 'Yoga launch').title, 'Green Studio sent new content')
})

const needsDb = { skip: !DATABASE_URL && 'no DATABASE_URL' }

test('notifications reach saved devices and expired devices are forgotten', needsDb, async () => {
  const owner = `push-selftest-${Date.now()}`
  const live = 'https://fcm.googleapis.com/fcm/send/live-selftest'
  const dead = 'https://fcm.googleapis.com/fcm/send/dead-selftest'
  await db.saveSubscription(owner, { endpoint: live, p256dh: 'k', auth: 'a' })
  await db.saveSubscription(owner, { endpoint: dead, p256dh: 'k', auth: 'a' })
  try {
    const delivered = []
    const send = async (sub, payload) => {
      if (sub.endpoint === dead) throw Object.assign(new Error('gone'), { statusCode: 410 })
      delivered.push({ endpoint: sub.endpoint, title: payload.title, url: payload.url })
    }
    const result = await notifyOwner(owner, { title: 'Hello', body: 'World' }, { send })
    assert.deepEqual(result, { sent: 1, failed: 1 })
    assert.deepEqual(delivered, [{ endpoint: live, title: 'Hello', url: '/' }])
    assert.deepEqual((await db.listSubscriptions(owner)).map((s) => s.endpoint), [live])

    // another manager cannot remove this manager's device
    await db.deleteSubscription(live, 'someone-else')
    assert.equal((await db.listSubscriptions(owner)).length, 1)
  } finally {
    await db.deleteSubscription(live)
    await db.deleteSubscription(dead)
  }
})

test('a manager with no devices is a quiet no-op', needsDb, async () => {
  assert.deepEqual(await notifyOwner(`nobody-${Date.now()}`, { title: 'x' }, { send: async () => { throw new Error('must not be called') } }), { sent: 0, failed: 0 })
})

test('the app keeps one stable notification key', needsDb, async () => {
  const first = await publicKey()
  assert.match(first, /^[A-Za-z0-9_-]{80,100}$/)
  assert.equal(await publicKey(), first)
})
