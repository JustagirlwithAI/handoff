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
  const buttons = [copy]
  // The phone's or computer's own share menu: WhatsApp, Telegram, Slack, email,
  // whatever the client prefers. Handoff does not pick an app for you.
  if (navigator.share) {
    buttons.push(button('Share…', 'btn secondary', async () => {
      try {
        await navigator.share({
          title: 'Your Handoff page',
          text: `Hi ${name}, here is your private page. You can send me content and approve posts there, with no account needed:`,
          url: link,
        })
      } catch {
        // They closed the share menu: nothing to do.
      }
    }))
  }
  box.replaceChildren(
    document.createTextNode(`Private link for ${name}. Copy or share it now: it can't be shown again, but you can always make a new one.`),
    input,
    el('div', 'actions'),
  )
  box.lastChild.append(...buttons)
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

function shareRow(share, reload, hideFeedback) {
  const item = el('li')
  const top = el('div', 'row')
  top.append(
    el('span', `badge ${share.status}`, STATUS_LABEL[share.status] || share.status),
    button('Remove', 'link danger', async () => {
      if (!confirm('Stop sharing this post with the client?')) return
      try {
        await api(`/api/shares/${share.id}`, { method: 'DELETE' })
        await reload()
      } catch (err) {
        showError(err.message)
      }
    }),
  )
  const flat = share.text.replace(/\s+/g, ' ').trim()
  item.append(top, el('div', 'hint', `[${share.service}] ${flat.length > 90 ? `${flat.slice(0, 89).trimEnd()}…` : flat}`))
  // The newest change request is already shown at the top of the card.
  if (share.feedback && !hideFeedback) item.append(el('div', 'feedback', `"${share.feedback}"`))
  if (share.status !== 'waiting' && share.noteSaved === false) {
    item.append(el('div', 'hint', 'Saved here, but the Buffer Note could not be added.'))
  }
  if (share.status !== 'approved') item.append(updateControl(share, reload))
  return item
}

// After the manager revises the post in Buffer: show the client the new version
// and ask them again. One optional line tells them what changed.
function updateControl(share, reload) {
  const wrap = el('div', 'update')
  const label = share.status === 'changes' ? 'Send updated version' : 'Refresh from Buffer'
  const start = button(label, 'link', () => {
    const note = el('input')
    note.type = 'text'
    note.maxLength = 300
    note.placeholder = 'What changed? (optional, the client will see it)'
    note.setAttribute('aria-label', 'Note to the client')
    const send = button('Send', 'btn small', async () => {
      send.disabled = true
      showError('')
      try {
        await api(`/api/shares/${share.id}/refresh`, { method: 'POST', body: JSON.stringify({ note: note.value }) })
        await reload()
      } catch (err) {
        showError(err.message)
        send.disabled = false
      }
    })
    const cancel = button('Cancel', 'link', () => wrap.replaceChildren(start))
    wrap.replaceChildren(note, send, cancel)
    note.focus()
  })
  wrap.append(start)
  return wrap
}

// A visible "Share a draft" button on every client card. Handoff already shows a
// client any draft made from their own content; this is for drafts written from scratch.
function shareControl(client, reload) {
  const wrap = el('div', 'share-hand')
  const start = button('＋ Share a draft', 'btn small', async () => {
    start.disabled = true
    showError('')
    try {
      const { drafts } = await api('/api/drafts')
      const taken = new Set(client.shares.map((s) => s.postId))
      const choices = drafts.filter((d) => !taken.has(d.id))
      const cancel = button('Cancel', 'link', () => wrap.replaceChildren(start))
      if (!choices.length) {
        wrap.replaceChildren(el('span', 'tip', 'No drafts to share yet. Create a draft in Buffer first, then come back.'), cancel)
        return
      }
      const select = el('select')
      select.setAttribute('aria-label', 'Draft to share')
      select.append(...choices.map((d) => {
        const option = el('option', '', `[${d.service}] ${d.text.replace(/\s+/g, ' ').slice(0, 60) || '(no text)'}`)
        option.value = d.id
        return option
      }))
      const go = button('Share', 'btn small', async () => {
        go.disabled = true
        try {
          await api(`/api/clients/${client.id}/shares`, { method: 'POST', body: JSON.stringify({ postId: select.value }) })
          await reload()
        } catch (err) {
          showError(err.message)
          go.disabled = false
        }
      })
      wrap.replaceChildren(select, go, cancel)
    } catch (err) {
      showError(err.message)
      start.disabled = false
    }
  })
  start.title = `Pick a draft from Buffer to show ${client.name} for approval`
  wrap.append(start)
  return wrap
}

// Which client rows are open. A row you have not seen before opens by itself when
// nothing is shared yet, so the next step (Share a draft) is right there.
const openRows = new Set()
const seenRows = new Set()

function clientCard(client, reload) {
  if (!seenRows.has(client.id)) {
    seenRows.add(client.id)
    if (!client.shares.length) openRows.add(client.id)
  }
  const card = el('details', 'client')
  card.open = openRows.has(client.id)
  card.addEventListener('toggle', () => (card.open ? openRows.add(client.id) : openRows.delete(client.id)))

  // The row you tap: name, a count per status, and a chevron.
  const summary = el('summary')
  summary.append(el('span', 'client-name', client.name))
  const chips = el('span', 'chips')
  for (const status of ['changes', 'waiting', 'approved']) {
    if (client.counts[status]) chips.append(chip(status, client.counts[status]))
  }
  if (!chips.children.length) chips.append(el('span', 'tip', 'Nothing shared yet'))
  summary.append(chips)

  // The newest change request, in one line, visible even when the row is closed.
  const latest = client.shares.find((s) => s.status === 'changes' && s.feedback)
  if (latest) summary.append(el('p', 'client-sub', `"${latest.feedback}"`))
  card.append(summary)

  const body = el('div', 'client-body')
  body.append(shareControl(client, reload))
  if (client.shares.length) {
    const list = el('ul', 'board')
    list.append(...client.shares.map((s) => shareRow(s, reload, s === latest)))
    body.append(list)
  }

  const actions = el('div', 'actions')
  if (client.counts.changes) {
    const open = el('a', 'btn small', 'Open Buffer')
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
    el('span', 'spacer'),
    button('Delete client', 'link danger', async () => {
      if (!confirm(`Delete ${client.name}? Their link will stop working.`)) return
      try {
        await api(`/api/clients/${client.id}`, { method: 'DELETE' })
        await reload()
      } catch (err) {
        showError(err.message)
      }
    }),
  )
  body.append(actions)
  card.append(body)
  return card
}

const HOW_IT_WORKS = [
  ['Add a client', 'and send them their private link.'],
  ['They send content.', 'It lands in your Buffer as an Idea.'],
  ['Turn it into a draft in Buffer.', 'Handoff shows it to them to approve.'],
  ['Their answer comes back', 'as a note on your post, and a notification.'],
]

function howItWorks(className) {
  const list = el('ol', className)
  list.append(...HOW_IT_WORKS.map(([lead, rest]) => {
    const item = el('li')
    item.append(el('strong', '', lead), document.createTextNode(` ${rest}`))
    return item
  }))
  return list
}

async function loadOverview() {
  const container = $('clients')
  try {
    const { clients } = await api('/api/overview')
    // Clients that need attention come first.
    clients.sort((a, b) => (b.counts.changes - a.counts.changes) || (b.counts.waiting - a.counts.waiting))
    $('clients-label').hidden = !clients.length

    if (!clients.length) {
      // First visit: explain the whole idea once, where it is needed.
      container.className = 'empty'
      const heading = el('h2', '', 'Start with your first client')
      const lede = el('p', 'tip', 'Each client gets a private link, so they never need an account.')
      container.replaceChildren(heading, lede, howItWorks('steps'))
      $('help').replaceChildren()
      return
    }

    container.className = 'group'
    container.replaceChildren(...clients.map((c) => clientCard(c, loadOverview)))

    // Afterwards the explanation steps aside into a small, closed "?" help.
    const help = el('details', 'help')
    help.append(el('summary', '', 'How Handoff works'), howItWorks('steps'))
    $('help').replaceChildren(help)
  } catch (err) {
    container.className = ''
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
    toggle.textContent = current ? 'Turn off' : 'Turn on'
    toggle.className = current ? 'link' : 'btn small'
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
  $('account').textContent = account.name || account.email
  $('appbar-actions').hidden = false
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
