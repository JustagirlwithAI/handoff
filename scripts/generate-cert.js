// Generates a self-signed certificate for https://localhost:3000.
// Buffer's registered redirect URI uses https, so the dev server needs TLS.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const dir = path.join(import.meta.dirname, '..', 'certs')
const key = path.join(dir, 'key.pem')
const cert = path.join(dir, 'cert.pem')

export function ensureCert() {
  if (fs.existsSync(key) && fs.existsSync(cert)) return { key, cert }

  fs.mkdirSync(dir, { recursive: true })
  const args = [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '825',
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ]
  try {
    execFileSync('openssl', args, { stdio: 'pipe' })
  } catch {
    // Older openssl builds reject -addext; fall back without the SAN extension.
    execFileSync('openssl', args.slice(0, -2), { stdio: 'inherit' })
  }
  console.log('Generated self-signed certificate in ./certs')
  return { key, cert }
}

if (process.argv[1] === import.meta.filename) ensureCert()
