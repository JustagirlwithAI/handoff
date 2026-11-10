import assert from 'node:assert/strict'
import test from 'node:test'

process.env.BUFFER_CLIENT_ID ||= 'test-client'
const { snapshotFromPost } = await import('../lib/approvals.js')

test('a post snapshot keeps only what the client needs', () => {
  const snap = snapshotFromPost({
    id: 'abc', status: 'draft', text: 'Hello', channelService: 'linkedin', dueAt: null,
    channel: { name: 'acct', displayName: 'My Page' },
    assets: [
      { type: 'image', source: 'https://cdn.example/a.jpg', thumbnail: 'https://cdn.example/a_t.jpg' },
      { type: 'video', source: 'https://cdn.example/v.mp4', thumbnail: 'https://cdn.example/v.jpg' },
      { type: 'image', source: 'javascript:alert(1)', thumbnail: '' },
      { type: 'image', source: 'http://insecure.example/x.jpg', thumbnail: '' },
    ],
  })
  assert.equal(snap.channel, 'My Page')
  assert.equal(snap.service, 'linkedin')
  assert.deepEqual(snap.images.map((i) => i.url), ['https://cdn.example/a.jpg', 'https://cdn.example/v.jpg'])
})

test('a post with no text or assets still produces a safe snapshot', () => {
  const snap = snapshotFromPost({ text: null, channelService: 'x', channel: null, assets: null })
  assert.equal(snap.text, '')
  assert.deepEqual(snap.images, [])
})

const { snapshotUpdates, sameSnapshot } = await import('../lib/approvals.js')

test('a post scheduled in Buffer reaches the client; approved wording is never changed behind their back', () => {
  const old = { text: 'Hello', service: 'linkedin', channel: 'Page', dueAt: null, images: [] }
  const post = (over) => ({ id: 'p1', text: 'Hello', service: 'linkedin', channel: { name: 'Page' }, dueAt: null, assets: [], ...over })
  const asPost = (over) => ({ ...old, id: 'p1', ...over }) // shape produced by listPosts

  // waiting: everything follows Buffer
  let ups = snapshotUpdates([asPost({ dueAt: '2026-11-11T17:00:00.000Z', text: 'Hello, edited' })], [{ id: 's1', post_id: 'p1', status: 'waiting', snapshot: old }])
  assert.equal(ups.length, 1)
  assert.equal(ups[0].snapshot.dueAt, '2026-11-11T17:00:00.000Z')
  assert.equal(ups[0].snapshot.text, 'Hello, edited')

  // approved: only the date follows Buffer, the approved wording stays
  ups = snapshotUpdates([asPost({ dueAt: '2026-11-11T17:00:00.000Z', text: 'Rewritten after approval' })], [{ id: 's2', post_id: 'p1', status: 'approved', snapshot: old }])
  assert.equal(ups[0].snapshot.dueAt, '2026-11-11T17:00:00.000Z')
  assert.equal(ups[0].snapshot.text, 'Hello')

  // nothing changed, or the post is gone from Buffer's active list: no update
  assert.deepEqual(snapshotUpdates([asPost({})], [{ id: 's3', post_id: 'p1', status: 'waiting', snapshot: old }]), [])
  assert.deepEqual(snapshotUpdates([], [{ id: 's4', post_id: 'p9', status: 'waiting', snapshot: old }]), [])
  assert.equal(sameSnapshot({ ...old, images: [{ url: 'a' }] }, { ...old, images: [{ url: 'a' }] }), true)
  assert.equal(sameSnapshot(old, { ...old, images: [{ url: 'a' }] }), false)
  void post
})

const { editedState, contentDiffers } = await import('../lib/approvals.js')

test('a "changes requested" post is flagged once it has been edited in Buffer', () => {
  const seen = { text: 'Old caption', service: 'linkedin', channel: 'Page', dueAt: null, images: [{ type: 'image', url: 'https://x/1.jpg' }] }
  const post = (over) => ({ id: 'p1', ...seen, ...over })
  const index = [
    { id: 's-changes', post_id: 'p1', status: 'changes', snapshot: seen },
    { id: 's-waiting', post_id: 'p1', status: 'waiting', snapshot: seen },
    { id: 's-approved', post_id: 'p1', status: 'approved', snapshot: seen },
  ]
  // edited words: flagged, and only the "changes" one counts
  assert.deepEqual(editedState([post({ text: 'New caption' })], index), { edited: ['s-changes'], unedited: [] })
  // a new photo counts too
  assert.deepEqual(editedState([post({ images: [{ type: 'image', url: 'https://x/2.jpg' }] })], index).edited, ['s-changes'])
  // scheduling or moving it is NOT an edit worth re-sending
  assert.deepEqual(editedState([post({ dueAt: '2026-12-01T10:00:00Z', channel: 'Other' })], index), { edited: [], unedited: ['s-changes'] })
  // an unchanged post is not flagged, and a post gone from Buffer is left alone
  assert.deepEqual(editedState([post({})], index), { edited: [], unedited: ['s-changes'] })
  assert.deepEqual(editedState([], index), { edited: [], unedited: [] })
  assert.equal(contentDiffers(seen, { ...seen }), false)
})
