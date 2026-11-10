import assert from 'node:assert/strict'
import test from 'node:test'

process.env.BUFFER_CLIENT_ID ||= 'test-client'
const { DATABASE_URL } = await import('../lib/config.js')
const db = await import('../lib/db.js')

const needsDb = { skip: !DATABASE_URL && 'no DATABASE_URL' }
const snap = (text) => ({ text, service: 'linkedin', channel: 'Page', dueAt: null, images: [] })

test('every action is recorded with a time, and only the owner can read it', needsDb, async () => {
  const owner = `hist-owner-${Date.now()}`
  const stranger = `hist-stranger-${Date.now()}`
  const { client } = await db.createClient(owner, `HistClient ${Date.now()}`)
  try {
    const shareId = await db.createShare(owner, client.id, 'histpost0001', snap('Fresh bread today'))
    await db.recordDecision(shareId, { status: 'changes', feedback: 'Please shorten it', noteSaved: true })
    await db.refreshShare(owner, shareId, snap('Fresh bread'), 'Shortened the caption')
    await db.recordDecision(shareId, { status: 'approved', feedback: '', noteSaved: true })

    const events = await db.listEvents(owner)
    assert.deepEqual(events.map((e) => e.kind), ['approved', 'updated', 'changes', 'shared']) // newest first
    assert.ok(events.every((e) => e.created_at instanceof Date && !Number.isNaN(e.created_at.getTime())))
    assert.equal(events.find((e) => e.kind === 'changes').comment, 'Please shorten it')
    assert.equal(events.find((e) => e.kind === 'updated').comment, 'Shortened the caption')

    // filtering, and nobody else sees any of it
    assert.deepEqual((await db.listEvents(owner, 'changes')).map((e) => e.kind), ['changes'])
    assert.equal((await db.listEvents(stranger)).length, 0)
  } finally {
    await db.deleteClient(owner, client.id)
  }
})

test('a client only sees posts that still need their answer', needsDb, async () => {
  const owner = `hist-owner2-${Date.now()}`
  const { client } = await db.createClient(owner, `HistClient2 ${Date.now()}`)
  try {
    const a = await db.createShare(owner, client.id, 'histpost0002', snap('Waiting one'))
    const b = await db.createShare(owner, client.id, 'histpost0003', snap('Approved one'))
    const c = await db.createShare(owner, client.id, 'histpost0004', snap('Changes one'))
    await db.recordDecision(b, { status: 'approved', feedback: '', noteSaved: true })
    await db.recordDecision(c, { status: 'changes', feedback: 'Tweak', noteSaved: true })

    const visible = await db.listSharesForClient(client.id)
    assert.deepEqual(visible.map((s) => s.id), [a])
    assert.ok(!('feedback' in visible[0]), 'the client is not sent their old feedback')

    // after the manager revises it, the changed post is back in front of them
    await db.refreshShare(owner, c, snap('Changes one, fixed'), 'Done')
    const again = await db.listSharesForClient(client.id)
    assert.deepEqual(again.map((s) => s.id).sort(), [a, c].sort())
    assert.equal(again.find((s) => s.id === c).updated, true)
  } finally {
    await db.deleteClient(owner, client.id)
  }
})

test('the "has anything changed?" check moves when something happens, and only then', needsDb, async () => {
  const owner = `hist-owner3-${Date.now()}`
  const { client } = await db.createClient(owner, `HistClient3 ${Date.now()}`)
  try {
    const before = await db.pulseForOwner(owner)
    assert.equal(await db.pulseForOwner(owner), before, 'unchanged while nothing happens')
    const clientBefore = await db.pulseForClient(client.id)

    const shareId = await db.createShare(owner, client.id, 'histpost0005', snap('Pulse post'))
    const afterShare = await db.pulseForOwner(owner)
    assert.notEqual(afterShare, before)
    assert.notEqual(await db.pulseForClient(client.id), clientBefore)

    await db.recordDecision(shareId, { status: 'approved', feedback: '', noteSaved: true })
    assert.notEqual(await db.pulseForOwner(owner), afterShare)

    // another owner's activity never moves this owner's check
    const otherOwner = `hist-other-${Date.now()}`
    const other = await db.createClient(otherOwner, `HistOther ${Date.now()}`)
    try {
      const settled = await db.pulseForOwner(owner)
      await db.createShare(otherOwner, other.client.id, 'histpost0006', snap('Other'))
      assert.equal(await db.pulseForOwner(owner), settled)
    } finally {
      await db.deleteClient(otherOwner, other.client.id)
    }
  } finally {
    await db.deleteClient(owner, client.id)
  }
})

test('History is ordered by when things really happened, not by when they were saved', needsDb, async () => {
  const { neon } = await import('@neondatabase/serverless')
  const sql = neon(DATABASE_URL)
  const owner = `hist-order-${Date.now()}`
  const { client } = await db.createClient(owner, `HistOrder ${Date.now()}`)
  try {
    // Saved in the "wrong" order on purpose: the newest event gets the lowest id.
    const days = [0, 2, 1, 3] // days ago
    for (const d of days) {
      await sql`INSERT INTO events (client_id, kind, post_text, created_at)
                VALUES (${client.id}, 'approved', ${`${d} days ago`}, now() - make_interval(days => ${d}))`
    }
    const order = (await db.listEvents(owner)).map((e) => e.post_text)
    assert.deepEqual(order, ['0 days ago', '1 days ago', '2 days ago', '3 days ago'])
  } finally {
    await db.deleteClient(owner, client.id)
  }
})

test('an entry keeps the exact post as it was, in full, and only its owner can open it', needsDb, async () => {
  const owner = `hist-detail-${Date.now()}`
  const { client } = await db.createClient(owner, `HistDetail ${Date.now()}`)
  try {
    const longText = `Line one.\n\n${'A long caption that goes well past the short preview length. '.repeat(15)}END`
    assert.ok(longText.length > 600)
    const shareId = await db.createShare(owner, client.id, 'histpost0101', { ...snap(longText), images: [{ type: 'image', url: 'https://cdn.example/a.jpg' }] })
    await db.recordDecision(shareId, { status: 'approved', feedback: 'Love it', noteSaved: true })

    // the manager rewrites the post afterwards; what was approved must not change
    await db.refreshShare(owner, shareId, snap('A completely different text'), 'Rewrote it')

    const approved = (await db.listEvents(owner, 'approved'))[0]
    const full = await db.getEvent(owner, approved.id)
    assert.equal(full.snapshot.text, longText, 'the whole text, not the 300-character preview')
    assert.equal(full.snapshot.images[0].url, 'https://cdn.example/a.jpg')
    assert.equal(full.comment, 'Love it')

    const updated = await db.getEvent(owner, (await db.listEvents(owner, 'updated'))[0].id)
    assert.equal(updated.snapshot.text, 'A completely different text')

    assert.equal(await db.getEvent(`someone-else-${Date.now()}`, approved.id), null)
  } finally {
    await db.deleteClient(owner, client.id)
  }
})

test('what a client sent is kept in full too', needsDb, async () => {
  const owner = `hist-sent-${Date.now()}`
  const { client } = await db.createClient(owner, `HistSent ${Date.now()}`)
  try {
    const id = await db.createSubmission(client.id, {
      title: 'Weekend sale', text: 'Everything half price', details: 'Use #sale', timing: 'Morning', date: '2026-12-01', photos: ['https://cdn.example/p.jpg'],
    })
    await db.finishSubmission(id, { ideaId: 'idea1' })
    const sent = await db.getEvent(owner, (await db.listEvents(owner, 'submitted'))[0].id)
    assert.deepEqual(
      { title: sent.snapshot.title, text: sent.snapshot.text, details: sent.snapshot.details, timing: sent.snapshot.timing, date: sent.snapshot.date, photos: sent.snapshot.photos },
      { title: 'Weekend sale', text: 'Everything half price', details: 'Use #sale', timing: 'Morning', date: '2026-12-01', photos: ['https://cdn.example/p.jpg'] },
    )
  } finally {
    await db.deleteClient(owner, client.id)
  }
})
