import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

process.env.BUFFER_CLIENT_ID ||= 'test-client'
process.env.CLOUDINARY_CLOUD_NAME = 'democloud'
process.env.CLOUDINARY_API_KEY = '123456'
process.env.CLOUDINARY_API_SECRET = 'shhh-secret'
const { signUpload, isOwnPhotoUrl } = await import('../lib/cloudinary.js')
const { buildIdeaContent } = await import('../lib/ideas.js')

const CLIENT = '0b1d3c5e-1111-4222-8333-444455556666'

test('upload signatures follow Cloudinary rules and never reveal the secret', () => {
  const s = signUpload(CLIENT, 1700000000)
  const expected = crypto.createHash('sha1')
    .update(`allowed_formats=jpg,jpeg,png,webp,gif&folder=handoff/${CLIENT}&timestamp=1700000000shhh-secret`)
    .digest('hex')
  assert.equal(s.signature, expected)
  assert.equal(s.folder, `handoff/${CLIENT}`)
  assert.ok(!JSON.stringify(s).includes('shhh-secret'))
})

test('only photos in this client\'s own Cloudinary folder are accepted', () => {
  const good = `https://res.cloudinary.com/democloud/image/upload/v1/handoff/${CLIENT}/pic.jpg`
  assert.equal(isOwnPhotoUrl(good, CLIENT), true)
  const bad = [
    `https://evil.example/democloud/image/upload/v1/handoff/${CLIENT}/pic.jpg`,
    `https://res.cloudinary.com/othercloud/image/upload/v1/handoff/${CLIENT}/pic.jpg`,
    `https://res.cloudinary.com/democloud/image/upload/v1/handoff/another-client/pic.jpg`,
    `http://res.cloudinary.com/democloud/image/upload/v1/handoff/${CLIENT}/pic.jpg`,
    `${good}?track=1`,
    'javascript:alert(1)', 'not a url', '', null, 42,
  ]
  for (const url of bad) assert.equal(isOwnPhotoUrl(url, CLIENT), false, String(url))
})

test('an Idea always starts with the client name, tagged or not', () => {
  const client = { name: 'Sunrise Bakery' }
  const sub = { title: 'Sale', text: 'Fresh bread!', details: 'Use #bread', timing: 'Morning', date: '2026-12-01', photos: ['https://x/y.jpg'] }

  const tagged = buildIdeaContent(client, sub, { id: 't1', name: 'Sunrise Bakery', color: '#418829' })
  assert.equal(tagged.title, 'Sunrise Bakery: Sale')
  assert.deepEqual(tagged.tags, [{ id: 't1', name: 'Sunrise Bakery', color: '#418829' }])
  assert.deepEqual(tagged.media, [{ url: 'https://x/y.jpg', type: 'image' }])
  assert.match(tagged.text, /Fresh bread!/)
  assert.match(tagged.text, /Details: Use #bread/)
  assert.match(tagged.text, /Preferred timing: Morning/)
  assert.equal(tagged.date, '2026-12-01T09:00:00.000Z')

  const untagged = buildIdeaContent(client, { ...sub, photos: [], date: '' }, null)
  assert.equal(untagged.title, 'Sunrise Bakery: Sale')
  assert.equal(untagged.tags, undefined)
  assert.equal(untagged.media, undefined)
})
