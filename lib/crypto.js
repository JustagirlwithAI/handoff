import crypto from 'node:crypto'
import { SESSION_SECRET } from './config.js'

// Buffer access and refresh tokens are stored in the database, so they are
// encrypted first. A leaked database alone is then useless to an attacker: they
// would also need the app's secret, which lives only in the host's settings.
//
// The key is derived from SESSION_SECRET (which production already requires), so
// there is no extra secret to manage. Changing SESSION_SECRET makes stored tokens
// unreadable: the manager simply signs in with Buffer again.
const KEY = Buffer.from(
  crypto.hkdfSync('sha256', SESSION_SECRET, 'handoff', 'buffer-token-encryption', 32),
)

// AES-256-GCM encrypts and also detects tampering. Output: iv.tag.ciphertext
export function encrypt(plain) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv)
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.')
}

// Returns null if the value is damaged or was sealed with a different key.
export function decrypt(sealed) {
  try {
    const [iv, tag, data] = String(sealed).split('.').map((s) => Buffer.from(s, 'base64url'))
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}
