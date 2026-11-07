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
