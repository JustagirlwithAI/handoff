import assert from 'node:assert/strict'
import test from 'node:test'

process.env.BUFFER_CLIENT_ID ||= 'test-client'
const { encrypt, decrypt } = await import('../lib/crypto.js')

test('encrypted tokens decrypt back to the original', () => {
  const secret = 'access-token-1234'
  const sealed = encrypt(secret)
  assert.ok(!sealed.includes(secret))
  assert.equal(decrypt(sealed), secret)
})

test('encrypting the same value twice gives different output', () => {
  assert.notEqual(encrypt('same'), encrypt('same'))
})

test('tampered or garbage values decrypt to null instead of crashing', () => {
  const sealed = encrypt('hello')
  const [iv, tag, data] = sealed.split('.')
  assert.equal(decrypt([iv, tag, `${data}A`].join('.')), null)
  assert.equal(decrypt('garbage'), null)
  assert.equal(decrypt(''), null)
  assert.equal(decrypt(undefined), null)
})
