// Standalone server.
//
// Locally it serves HTTPS with a self-signed certificate, because Buffer's
// registered redirect URI uses https. Anywhere in production the platform
// terminates TLS in front of us, so it serves plain HTTP on the injected port
// and never touches the filesystem — a serverless filesystem is read-only.
//
// Serverless deployments route through api/index.js instead, which exports the
// same app without listening at all.
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import app from './lib/app.js'
import { CLIENT_ID, CLIENT_SECRET, IS_PRODUCTION, PORT, REDIRECT_URI } from './lib/config.js'

// Hosts terminate TLS in front of the app and hand it plain HTTP, so the same
// signal that makes a real SESSION_SECRET mandatory also decides this. Naming
// one platform here would leave the app broken on every other one.
const platformTerminatesTls = IS_PRODUCTION

function describe(scheme) {
  console.log(`\n  Listening on ${scheme}://0.0.0.0:${PORT}`)
  if (!platformTerminatesTls) console.log(`  Open:         ${scheme}://localhost:${PORT}`)
  console.log(`  Redirect URI: ${REDIRECT_URI}`)
  console.log(`  Client:       ${CLIENT_ID} (${CLIENT_SECRET ? 'confidential' : 'public / PKCE only'})`)
  if (scheme === 'https') console.log('\n  The certificate is self-signed — accept the browser warning once.')
  console.log()
}

if (platformTerminatesTls) {
  http.createServer(app).listen(PORT, () => describe('http'))
} else {
  // Imported lazily so the certificate helper never loads in a serverless build.
  const { ensureCert } = await import('./scripts/generate-cert.js')
  const { key, cert } = ensureCert()
  https
    .createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, app)
    .listen(PORT, () => describe('https'))
}
