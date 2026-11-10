// Handoff service worker. Its job is to show notifications that look like they
// come from a real app, even when the Handoff page is closed.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

// A client's page tells us its own address, so that tapping a notification can
// take them back to it (the address contains their private link, so it is kept
// only on their own device, never sent anywhere).
const CLIENT_PATH = /^\/c\/[A-Za-z0-9_-]{43}$/
const META_CACHE = 'handoff-meta'
const META_KEY = '/__client-path'

self.addEventListener('message', (event) => {
  const data = event.data || {}
  if (data.type === 'client-path' && CLIENT_PATH.test(data.path)) {
    event.waitUntil(caches.open(META_CACHE).then((cache) => cache.put(META_KEY, new Response(data.path))))
  }
})

const httpsOnly = (url) => (typeof url === 'string' && /^https:\/\//i.test(url) ? url : undefined)

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: 'Handoff', body: event.data ? event.data.text() : '' }
  }
  const symbol = typeof data.emoji === 'string' ? data.emoji.slice(0, 4) : ''
  const title = `${symbol ? `${symbol} ` : ''}${String(data.title || 'Handoff').slice(0, 100)}`
  const options = {
    body: String(data.body || '').slice(0, 200),
    icon: '/icon-notify-192.png',   // the rounded Handoff app icon
    badge: '/badge-96.png',         // the small one-colour mark in a phone's status bar
    tag: data.tag || 'handoff',     // a newer notification of the same kind replaces the older one
    renotify: true,                 // ...but it still makes its sound/pop-up again
    timestamp: Date.now(),
    data: { kind: data.kind === 'client' ? 'client' : 'manager' },
  }
  const picture = httpsOnly(data.image)
  if (picture) options.image = picture // the post's photo, where the device supports it

  event.waitUntil(Promise.all([
    self.registration.showNotification(title, options),
    // Any Handoff page that is open updates itself straight away.
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const page of windows) page.postMessage({ type: 'refresh' })
    }),
  ]))
})

async function openTarget(kind) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  if (kind === 'client') {
    // Back to the client's own page: an open tab if there is one, else the saved address.
    for (const client of windows) {
      if (CLIENT_PATH.test(new URL(client.url).pathname) && 'focus' in client) return client.focus()
    }
    const cache = await caches.open(META_CACHE)
    const saved = await cache.match(META_KEY)
    const path = saved ? await saved.text() : '/'
    return self.clients.openWindow(CLIENT_PATH.test(path) ? path : '/')
  }
  // The manager: the dashboard.
  for (const client of windows) {
    if (new URL(client.url).pathname === '/' && 'focus' in client) return client.focus()
  }
  return self.clients.openWindow('/')
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(openTarget(event.notification.data?.kind))
})
