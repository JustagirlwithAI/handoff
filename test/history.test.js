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
