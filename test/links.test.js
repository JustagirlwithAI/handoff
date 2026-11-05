import assert from 'node:assert/strict'
import test from 'node:test'

process.env.BUFFER_CLIENT_ID ||= 'test-client'
const { createLinkToken, hashToken, TOKEN_PATTERN, findClientByToken } = await import('../lib/db.js')

test('link tokens are 43 URL-safe characters and never repeat', () => {
  const seen = new Set()
  for (let i = 0; i < 1000; i++) {
    const token = createLinkToken()
    assert.match(token, TOKEN_PATTERN)
    assert.ok(!seen.has(token))
    seen.add(token)
  }
})

test('only a fingerprint of the token is stored, and it is not the token', () => {
  const token = createLinkToken()
  const hash = hashToken(token)
  assert.notEqual(hash, token)
  assert.equal(hash, hashToken(token))
  assert.match(hash, /^[0-9a-f]{64}$/)
})

test('malformed tokens are refused before the database is ever asked', async () => {
  for (const bad of ['', 'short', 'x'.repeat(42), 'x'.repeat(44), `${'a'.repeat(42)}!`, "' OR 1=1 --", undefined, null, 42]) {
    assert.equal(await findClientByToken(bad), null)
  }
})
