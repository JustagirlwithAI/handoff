import crypto from 'node:crypto'
import { CLOUDINARY, PHOTOS_ENABLED } from './config.js'

// Photos go from the client's browser straight to Cloudinary, so they never
// pass through (and never overload) this server. The browser may only upload
// when this server has signed the request first, and we only sign for clients
// holding a valid private link. The secret never leaves the server.

const ALLOWED_FORMATS = 'jpg,jpeg,png,webp,gif'

export function signUpload(clientId, now = Math.floor(Date.now() / 1000)) {
  if (!PHOTOS_ENABLED) return null
  const params = {
    allowed_formats: ALLOWED_FORMATS,
    folder: `handoff/${clientId}`,
    timestamp: String(now),
  }
  // Cloudinary's rule: sort the parameters by name, join as name=value pairs
  // with &, append the secret, and take the SHA-1.
  const toSign = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&')
  const signature = crypto.createHash('sha1').update(toSign + CLOUDINARY.apiSecret).digest('hex')
  return { cloudName: CLOUDINARY.cloudName, apiKey: CLOUDINARY.apiKey, signature, ...params }
}

// A submission may only reference photos that were uploaded to OUR Cloudinary
// folder for THIS client. Anything else (someone else's site, a tracking URL)
// is refused, so clients cannot make Buffer fetch arbitrary addresses.
export function isOwnPhotoUrl(url, clientId, cloudName = CLOUDINARY.cloudName) {
  if (typeof url !== 'string' || url.length > 500 || !cloudName) return false
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.hostname === 'res.cloudinary.com' &&
    !parsed.search &&
    parsed.pathname.startsWith(`/${cloudName}/image/upload/`) &&
    parsed.pathname.includes(`/handoff/${clientId}/`)
  )
}
