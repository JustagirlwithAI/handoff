import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

process.env.BUFFER_CLIENT_ID = 'test-client'
process.env.SESSION_SECRET = 'a'.repeat(32)
process.env.REDIRECT_URI = 'https://example.test/callback'

const { defaultRedirectUri, loginUnavailableReason } = await import('../lib/config.js')
const { buildAuthorizeUrl, buildPostInput, createPkcePair, exchangeCodeForTokens, refreshTokens, requestTokens } = await import('../lib/buffer.js')

test('PKCE pairs use an S256 base64url challenge', () => {
  const { verifier, challenge } = createPkcePair()
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/)
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(verifier, challenge)
})

test('authorization requests contain the configured callback and minimum scopes', () => {
  const url = new URL(buildAuthorizeUrl({ state: 'state', codeChallenge: 'challenge' }))
  assert.equal(url.searchParams.get('redirect_uri'), 'https://example.test/callback')
  assert.equal(url.searchParams.get('scope'), 'account:read posts:read posts:write ideas:read ideas:write notes:read notes:write offline_access')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
})

test('post input is always draft-only and adds service metadata', () => {
  const input = buildPostInput({
    channelId: 'channel-1',
    service: 'instagram',
    text: 'Hello',
    mediaUrl: 'https://cdn.example.test/photo.jpg',
  })
  assert.equal(input.saveToDraft, true)
  assert.equal(input.mode, 'addToQueue')
  assert.deepEqual(input.metadata, { instagram: { type: 'post', shouldShareToFeed: true } })
  assert.deepEqual(input.assets, [{ image: { url: 'https://cdn.example.test/photo.jpg' } }])
})

test('token responses map to an access token and a refresh token', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600, scope: 'account:read',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  try {
    const tokens = await requestTokens({ grant_type: 'authorization_code', code: 'code' })
    assert.equal(tokens.accessToken, 'access-token')
    assert.equal(tokens.refreshToken, 'refresh-token')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('refresh replaces the old refresh token', async () => {
  const originalFetch = globalThis.fetch
  let body
  globalThis.fetch = async (_url, options) => {
    body = new URLSearchParams(options.body)
    return new Response(JSON.stringify({
      access_token: 'new-access-token', refresh_token: 'new-refresh-token', expires_in: 3600,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const tokens = await refreshTokens({
      accessToken: 'old-access-token', refreshToken: 'old-refresh-token', connectedAt: 123,
    })
    assert.equal(body.get('grant_type'), 'refresh_token')
    assert.equal(body.get('refresh_token'), 'old-refresh-token')
    assert.equal(tokens.refreshToken, 'new-refresh-token')
    assert.equal(tokens.connectedAt, 123)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('the initial exchange requires a refresh token', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    access_token: 'access-token', expires_in: 3600,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  try {
    await assert.rejects(
      exchangeCodeForTokens({ code: 'code', codeVerifier: 'verifier' }),
      /enable offline_access/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('the browser code does not interpolate remote values with innerHTML', async () => {
  const client = await readFile(new URL('../public/app.js', import.meta.url), 'utf8')
  assert.doesNotMatch(client, /\.innerHTML\s*=/)
})

test('error detail reaches a developer but never a production user', async () => {
  const { withCause } = await import('../lib/config.js')
  assert.equal(
    withCause('Could not create that draft.', 'Text too long'),
    'Could not create that draft. (Text too long)',
  )

  // IS_PRODUCTION is read once at import, so the production half needs its own
  // process. Leaking an API's internals to end users is worth the extra spawn.
  const { execFileSync } = await import('node:child_process')
  const script = "const { withCause } = await import('./lib/config.js'); console.log(withCause('Generic.', 'secret detail'))"
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, NODE_ENV: 'production', BUFFER_CLIENT_ID: 'test-client', SESSION_SECRET: 'a'.repeat(32) },
    encoding: 'utf8',
  })
  assert.equal(output.trim(), 'Generic.')
})

test('only the Vercel production deployment defaults to the production callback', () => {
  const productionUrl = 'app.example.test'
  assert.equal(
    defaultRedirectUri({ VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: productionUrl }),
    'https://app.example.test/callback',
  )
  // Vercel sets the production URL on previews too; it must not be used there.
  assert.equal(defaultRedirectUri({ VERCEL_ENV: 'preview', VERCEL_PROJECT_PRODUCTION_URL: productionUrl }), null)
  assert.equal(defaultRedirectUri({ VERCEL_ENV: 'development', VERCEL_PROJECT_PRODUCTION_URL: productionUrl }), null)
  assert.equal(defaultRedirectUri({}), 'https://localhost:3000/callback')
})

test('login starts only on the host of the registered callback', () => {
  assert.equal(loginUnavailableReason('example.test', 'https://example.test/callback'), null)
  assert.equal(loginUnavailableReason('localhost:3000', 'https://localhost:3000/callback'), null)
  assert.match(loginUnavailableReason('app-git-branch.vercel.app', 'https://example.test/callback'), /only available at https:\/\/example\.test/)
  assert.match(loginUnavailableReason('127.0.0.1:3000', 'https://localhost:3000/callback'), /only available/)
  assert.match(loginUnavailableReason('app-git-branch.vercel.app', null), /disabled on this deployment/)
})
