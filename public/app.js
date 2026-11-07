const $ = (id) => document.getElementById(id)
const banner = $('banner')

function showError(message) {
  banner.textContent = message
  banner.hidden = !message
}

// Names, posts and API messages are remote data, so everything below is built
// with DOM APIs and textContent, never innerHTML. A test enforces this.
function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(label, className, onClick) {
  const node = el('button', className, label)
  node.type = 'button'
  node.addEventListener('click', onClick)
  return node
}

// The page never handles a Buffer token: it calls this app's own endpoints and
// the server attaches the connection. Errors arrive as { error }.
async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`)
  return body
}

// Surface an OAuth error that came back on the redirect, then clean the URL.
const params = new URLSearchParams(location.search)
if (params.get('error')) {
  showError(params.get('error'))
  history.replaceState({}, '', location.pathname)
}

/* ------------------------------------------------------------ new links */

// Shows a freshly made link once, with a Copy button. The server keeps only a
// fingerprint of it, so this is the only time it can be displayed.
function showLink(name, link) {
  const box = $('client-link')
  box.className = 'result ok'
  const input = el('input')
  input.type = 'text'
  input.readOnly = true
  input.value = link
  input.addEventListener('focus', () => input.select())
  const copy = button('Copy link', 'btn', async () => {
    try {
      await navigator.clipboard.writeText(link)
      copy.textContent = 'Copied!'
    } catch {
      input.select()
      copy.textContent = 'Press Ctrl+C to copy'
    }
  })
  box.replaceChildren(
    document.createTextNode(`Private link for ${name}. Copy it now: it can't be shown again, but you can always make a new one.`),
    input,
    copy,
  )
  box.hidden = false
}

$('client-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const add = $('client-add')
  showError('')
  add.disabled = true
  try {
    const { client, link } = await api('/api/clients', {
      method: 'POST',
      body: JSON.stringify({ name: $('client-name').value }),
    })
    $('client-name').value = ''
    showLink(client.name, link)
    await loadOverview()
  } catch (err) {
    showError(err.message)
  } finally {
    add.disabled = false
  }
})

/* ------------------------------------------------------------- dashboard */

const STATUS_LABEL = { waiting: 'Waiting', approved: 'Approved', changes: 'Needs changes' }

function chip(status, count) {
  return el('span', `badge ${status}`, `${count} ${STATUS_LABEL[status].toLowerCase()}`)
}

function shareRow(share, reload) {
  const item = el('li')
  const body = el('div')
  body.append(
    el('span', `badge ${share.status}`, STATUS_LABEL[share.status] || share.status),
    el('div', 'hint', `[${share.service}] ${share.text.replace(/\s+/g, ' ').slice(0, 90)}`),
  )
  if (share.feedback) body.append(el('div', 'feedback', `"${share.feedback}"`))
  if (share.status !== 'waiting' && share.noteSaved === false) {
    body.append(el('div', 'hint', 'Saved here, but the Buffer Note could not be added.'))
  }
  item.append(
    body,
    button('Remove', 'link', async () => {
      if (!confirm('Stop sharing this post with the client?')) return
      try {
        await api(`/api/shares/${share.id}`, { method: 'DELETE' })
        await reload()
      } catch (err) {
        showError(err.message)
      }
    }),
  )
  return item
}

// "Share a draft by hand": the fallback for drafts Handoff did not match itself.
function shareByHand(client, reload) {
  const wrap = el('div', 'share-hand')
  const open = button('Share a draft by hand', 'link', async () => {
    open.disabled = true
    try {
      const { drafts } = await api('/api/drafts')
      const taken = new Set(client.shares.map((s) => s.postId))
      const choices = drafts.filter((d) => !taken.has(d.id))
      const select = el('select')
      select.append(...(choices.length
        ? choices.map((d) => {
            const option = el('option', '', `[${d.service}] ${d.text.replace(/\s+/g, ' ').slice(0, 60) || '(no text)'}`)
            option.value = d.id
            return option
          })
        : [Object.assign(el('option', '', 'No other drafts in Buffer'), { value: '' })]))
      const go = button('Share', 'btn', async () => {
        if (!select.value) return
        go.disabled = true
        try {
          await api(`/api/clients/${client.id}/shares`, { method: 'POST', body: JSON.stringify({ postId: select.value }) })
          await reload()
        } catch (err) {
          showError(err.message)
          go.disabled = false
        }
      })
      wrap.replaceChildren(select, go)
    } catch (err) {
      showError(err.message)
      open.disabled = false
    }
  })
  wrap.append(open)
  return wrap
}

function clientCard(client, reload, openName) {
  const card = el('details', 'client')
  card.open = client.name === openName
  const summary = el('summary')
  summary.append(el('strong', '', client.name))
  const chips = el('span', 'chips')
  for (const status of ['changes', 'waiting', 'approved']) {
    if (client.counts[status]) chips.append(chip(status, client.counts[status]))
  }
  if (!chips.children.length) chips.append(el('span', 'hint', 'nothing shared yet'))
  summary.append(chips)
  card.append(summary)

  // The newest change request, in one line, right on the card.
  const latest = client.shares.find((s) => s.status === 'changes' && s.feedback)
  if (latest) card.append(el('div', 'feedback', `"${latest.feedback}"`))

  const body = el('div', 'client-body')
  if (client.shares.length) {
    const list = el('ul', 'board')
    list.append(...client.shares.map((s) => shareRow(s, reload)))
    body.append(list)
  }

  const actions = el('div', 'actions')
  if (client.counts.changes) {
    const open = el('a', 'btn', 'Open Buffer')
    open.href = 'https://publish.buffer.com'
    open.target = '_blank'
    open.rel = 'noopener noreferrer'
    actions.append(open)
  }
  actions.append(
    button('New link', 'link', async () => {
      if (!confirm(`Make a new link for ${client.name}? The old link will stop working.`)) return
      try {
        const { link } = await api(`/api/clients/${client.id}/link`, { method: 'POST' })
        showLink(client.name, link)
        scrollTo({ top: 0, behavior: 'smooth' })
      } catch (err) {
        showError(err.message)
      }
    }),
    button('Delete client', 'link', async () => {
      if (!confirm(`Delete ${client.name}? Their link will stop working.`)) return
      try {
        await api(`/api/clients/${client.id}`, { method: 'DELETE' })
        await reload()
      } catch (err) {
        showError(err.message)
      }
    }),
  )
  body.append(actions, shareByHand(client, reload))
  card.append(body)
  return card
}

let lastClients = []

async function loadOverview() {
  const container = $('clients')
  const openName = [...container.querySelectorAll('details[open] > summary strong')][0]?.textContent
  try {
    const { clients } = await api('/api/overview')
    // Clients that need attention come first.
    clients.sort((a, b) => (b.counts.changes - a.counts.changes) || (b.counts.waiting - a.counts.waiting))
    lastClients = clients
    if (!clients.length) {
      container.replaceChildren(el('p', 'hint', 'No clients yet. Add one above and send them their private link.'))
      return
    }
    container.replaceChildren(...clients.map((c) => clientCard(c, loadOverview, openName)))
  } catch (err) {
    container.replaceChildren(el('p', 'hint', err.message))
  }
}

/* --------------------------------------------------------- notifications */
// Notifications come from the browser's own push system, so they appear even when
// Handoff is closed. Each browser or phone is turned on separately.

const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

function keyToBytes(base64url) {
  const padded = base64url + '='.repeat((4 - (base64url.length % 4)) % 4)
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

async function setupNotifications() {
  const box = $('notify')
  const text = $('notify-text')
  const toggle = $('notify-toggle')
  const test = $('notify-test')
  box.hidden = false

  if (!pushSupported()) {
    text.textContent = 'This browser cannot show notifications. On an iPhone: tap Share, choose Add to Home Screen, then open Handoff from your Home Screen.'
    toggle.hidden = true
    return
  }

  const registration = await navigator.serviceWorker.register('/sw.js')
  const render = async () => {
    const current = await registration.pushManager.getSubscription()
    const blocked = Notification.permission === 'denied'
    test.hidden = !current
    toggle.hidden = blocked
    toggle.disabled = false
    if (blocked) text.textContent = 'Notifications are blocked for this site. Allow them in your browser settings (the lock icon by the address), then reload.'
    else if (current) text.textContent = '🔔 Notifications are on for this device.'
    else text.textContent = 'Get a notification when a client approves, asks for changes, or sends content.'
    toggle.textContent = current ? 'Turn off' : 'Turn on notifications'
    toggle.className = current ? 'link' : 'btn'
  }

  toggle.addEventListener('click', async () => {
    toggle.disabled = true
    showError('')
    try {
      const current = await registration.pushManager.getSubscription()
      if (current) {
        await api('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: current.endpoint }) })
        await current.unsubscribe()
      } else {
        if ((await Notification.requestPermission()) !== 'granted') return
        const { publicKey } = await api('/api/push/key')
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyToBytes(publicKey),
        })
        await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify(subscription.toJSON()) })
      }
    } catch (err) {
      showError(`Could not change notifications: ${err.message}`)
    } finally {
      await render()
    }
  })

  test.addEventListener('click', async () => {
    test.disabled = true
    try {
      const { sent } = await api('/api/push/test', { method: 'POST' })
      showError(sent ? '' : 'The test notification did not go through. Try turning notifications off and on again.')
    } catch (err) {
      showError(err.message)
    } finally {
      test.disabled = false
    }
  })

  await render()
}

async function start() {
  const session = await api('/api/session')
  if (!session.connected) {
    $('connect').hidden = false
    return
  }
  $('app').hidden = false
  const { account } = session
  $('account').textContent = `Signed in as ${account.name || account.email}`
  setupNotifications().catch(() => { $('notify').hidden = true })
  await loadOverview()
  // Stay current while the dashboard is open.
  setInterval(() => { if (!document.hidden) loadOverview() }, 60_000)
}

$('logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' })
  location.reload()
})

start().catch((err) => {
  showError(err.message)
  $('connect').hidden = false
})
