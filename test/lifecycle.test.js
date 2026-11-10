import assert from 'node:assert/strict'
import test from 'node:test'

process.env.BUFFER_CLIENT_ID ||= 'test-client'
const { DATABASE_URL } = await import('../lib/config.js')
const db = await import('../lib/db.js')

const needsDb = { skip: !DATABASE_URL && 'no DATABASE_URL' }
const snap = (text) => ({ text, service: 'linkedin', channel: 'Page', dueAt: null, images: [] })

test('archiving a client switches off their link, hides them, and keeps their record', needsDb, async () => {
  const owner = `life-owner-${Date.now()}`
  const name = `LifeClient ${Date.now()}`
  const { client, token } = await db.createClient(owner, name)
  try {
    const shareId = await db.createShare(owner, client.id, 'lifepost0001', snap('Fresh bread'))
    await db.recordDecision(shareId, { status: 'approved', feedback: '', noteSaved: true })
    assert.equal((await db.findClientByToken(token))?.id, client.id)

    await db.archiveClient(owner, client.id)
    assert.equal(await db.findClientByToken(token), null, 'the old link no longer works')
    assert.deepEqual((await db.listClients(owner)).map((c) => c.id), [], 'gone from the active list')
    const archived = await db.listArchivedClients(owner)
    assert.equal(archived.length, 1)
    assert.ok(archived[0].entries >= 2, 'the record is kept')

    // nothing new can be shared with an archived client
    await assert.rejects(() => db.createShare(owner, client.id, 'lifepost0002', snap('x')), /not found/i)
    // another manager cannot archive, restore or export it
    await assert.rejects(() => db.getClientRecord(`stranger-${Date.now()}`, client.id), /not found/i)
    await assert.rejects(() => db.restoreClient(`stranger-${Date.now()}`, client.id), /not found/i)

    // export: oldest first, with the full text
    const { events } = await db.getClientRecord(owner, client.id)
    assert.deepEqual(events.map((e) => e.kind), ['shared', 'approved'])
    assert.equal(events[0].snapshot?.text ?? events[0].post_text, 'Fresh bread')

    // restoring brings them back with a FRESH link; the old one stays dead
    const back = await db.restoreClient(owner, client.id)
    assert.equal(await db.findClientByToken(token), null)
    assert.equal((await db.findClientByToken(back.token))?.id, client.id)
    assert.equal((await db.listClients(owner)).length, 1)
    assert.equal((await db.listArchivedClients(owner)).length, 0)
  } finally {
    await db.deleteClient(owner, client.id)
  }
})

test('an archived name can be reused, but a restore cannot create a duplicate', needsDb, async () => {
  const owner = `life-owner2-${Date.now()}`
  const name = `LifeDup ${Date.now()}`
  const first = await db.createClient(owner, name)
  let second
  try {
    await db.archiveClient(owner, first.client.id)
    second = await db.createClient(owner, name) // allowed: the first one is archived
    await assert.rejects(() => db.restoreClient(owner, first.client.id), /already have an active client/i)
  } finally {
    await db.deleteClient(owner, first.client.id)
    if (second) await db.deleteClient(owner, second.client.id)
  }
})

test('the manager can tell when a client opened their link', needsDb, async () => {
  const owner = `life-owner3-${Date.now()}`
  const { client } = await db.createClient(owner, `LifeOpen ${Date.now()}`)
  try {
    assert.equal((await db.listClients(owner))[0].last_opened_at, null, 'never opened at first')
    const before = await db.pulseForOwner(owner)
    await db.markOpened(client.id)
    const opened = (await db.listClients(owner))[0].last_opened_at
    assert.ok(opened instanceof Date)
    assert.notEqual(await db.pulseForOwner(owner), before, 'the dashboard notices it live')

    // opening again straight away does not keep rewriting the record
    await db.markOpened(client.id)
    assert.equal((await db.listClients(owner))[0].last_opened_at.getTime(), opened.getTime())
  } finally {
    await db.deleteClient(owner, client.id)
  }
})

test('a reminder needs something waiting, and cannot be sent over and over', needsDb, async () => {
  const owner = `life-owner4-${Date.now()}`
  const { client } = await db.createClient(owner, `LifeNudge ${Date.now()}`)
  try {
    assert.equal(await db.countWaiting(owner, client.id), 0)
    await db.createShare(owner, client.id, 'lifepost0003', snap('Waiting post'))
    assert.equal(await db.countWaiting(owner, client.id), 1)
    assert.equal(await db.countWaiting(`stranger-${Date.now()}`, client.id), 0, 'owner-checked')

    assert.equal((await db.claimReminder(owner, client.id)).id, client.id)
    await assert.rejects(() => db.claimReminder(owner, client.id), (err) => err.status === 429 && /reminded/.test(err.message))
    await assert.rejects(() => db.claimReminder(`stranger-${Date.now()}`, client.id), /not found/i)
  } finally {
    await db.deleteClient(owner, client.id)
  }
})

test('drafts are shared only when the manager chooses, unless they switch automatic sharing on', needsDb, async () => {
  const { neon } = await import('@neondatabase/serverless')
  const sql = neon(DATABASE_URL)
  const owner = `life-auto-${Date.now()}`
  await sql`INSERT INTO owners (account_id, access_token_enc, refresh_token_enc, expires_at, connected_at)
            VALUES (${owner}, 'x', 'x', 0, 0)`
  try {
    assert.equal(await db.getAutoShare(owner), false, 'off by default')
    await db.setAutoShare(owner, true)
    assert.equal(await db.getAutoShare(owner), true)
    await db.setAutoShare(owner, false)
    assert.equal(await db.getAutoShare(owner), false)
    assert.equal(await db.getAutoShare(`nobody-${Date.now()}`), false)
  } finally {
    await sql`DELETE FROM owners WHERE account_id = ${owner}`
  }
})

test('the edited-in-Buffer flag is set, kept, and cleared when a new version is sent', needsDb, async () => {
  const owner = `life-edit-${Date.now()}`
  const { client } = await db.createClient(owner, `LifeEdit ${Date.now()}`)
  try {
    const id = await db.createShare(owner, client.id, 'lifepost0201', snap('First'))
    await db.recordDecision(id, { status: 'changes', feedback: 'Fix it', noteSaved: true })
    await db.markEdited([id])
    const flagged = (await db.listSharesForOwner(owner))[0].edited_at
    assert.ok(flagged instanceof Date)
    await db.markEdited([id]) // marking again keeps the first time
    assert.equal((await db.listSharesForOwner(owner))[0].edited_at.getTime(), flagged.getTime())
    await db.refreshShare(owner, id, snap('Second'), '')
    assert.equal((await db.listSharesForOwner(owner))[0].edited_at, null, 'sending the new version clears it')
  } finally {
    await db.deleteClient(owner, client.id)
  }
})
