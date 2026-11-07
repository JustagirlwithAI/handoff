// Handoff service worker. Its only job is to show notifications, even when the
// Handoff page is closed.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: 'Handoff', body: event.data ? event.data.text() : '' }
  }
  const title = String(data.title || 'Handoff').slice(0, 100)
  event.waitUntil(
    self.registration.showNotification(title, {
      body: String(data.body || '').slice(0, 200),
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || 'handoff', // a newer notification of the same kind replaces the older one
      data: { url: '/' },
    }),
  )
})

// Tapping a notification opens (or focuses) the dashboard.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (new URL(client.url).pathname === '/' && 'focus' in client) return client.focus()
      }
      return self.clients.openWindow('/')
    }),
  )
})
