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

const { matchClient } = await import('../lib/approvals.js')

test('a draft is matched to a client by tag, or by what the client wrote', () => {
  const clients = [{ id: 'c1', name: 'Sunrise Bakery' }, { id: 'c2', name: 'Green Studio' }]
  const bodies = [{ client_id: 'c1', body: 'Fresh bread daily' }, { client_id: 'c2', body: 'New yoga class' }]

  assert.equal(matchClient({ tags: ['Green Studio'], text: 'anything' }, clients, bodies).id, 'c2')
  assert.equal(matchClient({ tags: ['sunrise bakery'], text: '' }, clients, bodies).id, 'c1')
  assert.equal(matchClient({ tags: [], text: 'Fresh bread daily\n\n---\nDetails: x' }, clients, bodies).id, 'c1')
  // not sure, so do nothing (the manager can share by hand)
  assert.equal(matchClient({ tags: [], text: 'Something else entirely' }, clients, bodies), null)
  assert.equal(matchClient({ tags: ['Sunrise Bakery', 'Green Studio'], text: '' }, clients, bodies), null)
  // two clients with the same name: the text breaks the tie
  const twins = [{ id: 'a', name: 'Same' }, { id: 'b', name: 'Same' }]
  assert.equal(matchClient({ tags: ['Same'], text: 'Hello there' }, twins, [{ client_id: 'b', body: 'Hello' }]).id, 'b')
  assert.equal(matchClient({ tags: ['Same'], text: 'Unrelated' }, twins, [{ client_id: 'b', body: 'Hello' }]), null)
  assert.equal(matchClient({ tags: [], text: 'Fresh bread daily' }, clients, [...bodies, { client_id: 'c2', body: 'Fresh bread daily' }]), null)
  assert.equal(matchClient({ tags: [], text: 'x' }, clients, [{ client_id: 'c1', body: '  ' }]), null)
})
