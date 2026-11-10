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

// Personal preferences live in this browser only (nothing is sent to the server).
const PREF_THEME = 'handoff-theme'
const PREF_TIME = 'handoff-time'
function readPref(key, fallback, allowed) {
  try {
    const value = localStorage.getItem(key)
    return allowed.includes(value) ? value : fallback
  } catch {
    return fallback
  }
}
function writePref(key, value) {
  try { localStorage.setItem(key, value) } catch { /* private mode: the choice just will not stick */ }
}
let themePref = readPref(PREF_THEME, 'system', ['system', 'light', 'dark'])
let timePref = readPref(PREF_TIME, 'auto', ['auto', '12', '24'])

function applyTheme(value) {
  themePref = value
  if (value === 'light' || value === 'dark') document.documentElement.dataset.theme = value
  else delete document.documentElement.dataset.theme
  writePref(PREF_THEME, value)
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

// Date and time in the reader's own time zone, e.g. "Nov 10, 3:42 PM".
function when(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleString(undefined, {
    month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), hour: 'numeric', minute: '2-digit',
    ...(timePref === 'auto' ? {} : { hour12: timePref === '12' }),
  })
}

// The line that says what happened to a post, and when.
function timeline(share) {
  if (share.status === 'changes') return `Changes requested ${when(share.decidedAt)}`
  if (share.status === 'approved') return `Approved ${when(share.decidedAt)}`
  return share.updatedAt ? `Updated version sent ${when(share.updatedAt)}` : `Shared ${when(share.createdAt)}`
}

function shareRow(share, reload) {
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
  item.append(el('div', 'when', timeline(share)))
  if (share.feedback) item.append(el('div', 'feedback', `They asked: "${share.feedback}"`))
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
    const cancel = button('Cancel', 'link', () => { delete wrap.dataset.editing; wrap.replaceChildren(start) })
    wrap.dataset.editing = '1' // the page will not redraw over a box you are typing in
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
      const cancel = button('Cancel', 'link', () => { delete wrap.dataset.editing; wrap.replaceChildren(start) })
      wrap.dataset.editing = '1'
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
  // Only posts that still need something are listed here. Approved ones live in History.
  const open = client.shares.filter((s) => s.status !== 'approved')
  if (open.length) {
    const list = el('ul', 'board')
    list.append(...open.map((s) => shareRow(s, reload)))
    body.append(list)
  }

  const actions = el('div', 'actions')
  if (client.counts.changes) {
    const openBuffer = el('a', 'btn small', 'Open Buffer')
    openBuffer.href = 'https://publish.buffer.com'
    openBuffer.target = '_blank'
    openBuffer.rel = 'noopener noreferrer'
    actions.append(openBuffer)
  }
  if (client.counts.approved) {
    actions.append(button(`${client.counts.approved} approved: see History`, 'link', () => { location.hash = '#history' }))
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
  const dismissed = () => readPref('handoff-nudge', '', ['done']) === 'done'
  $('nudge-dismiss').addEventListener('click', () => {
    writePref('handoff-nudge', 'done')
    $('nudge').hidden = true
  })
  const render = async () => {
    const current = await registration.pushManager.getSubscription()
    const blocked = Notification.permission === 'denied'
    // A gentle reminder on the Clients screen, only until it is set up or dismissed.
    $('nudge').hidden = Boolean(current) || blocked || dismissed()
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

/* --------------------------------------------------------------- history */
// An orderly record of everything: approvals, change requests (and what was
// asked), updated versions sent, new content. Newest first, grouped by day.

const KIND_LABEL = {
  approved: 'Approved',
  changes: 'Changes requested',
  updated: 'Updated version sent',
  shared: 'Shared for review',
  submitted: 'Sent new content',
}
const KIND_BADGE = { approved: 'approved', changes: 'changes', updated: 'waiting', shared: '', submitted: '' }
const COMMENT_LEAD = { approved: 'They added: ', changes: 'They asked: ', updated: 'What changed: ' }
const FILTERS = [['', 'All'], ['approved', 'Approved'], ['changes', 'Changes requested'], ['updated', 'Updates sent']]

let historyKind = ''
let currentTab = 'clients'

function dayLabel(date) {
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diff = Math.round((day(new Date()) - day(date)) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

function renderFilters() {
  $('history-filters').replaceChildren(...FILTERS.map(([kind, label]) => {
    const chipButton = button(label, `filter${kind === historyKind ? ' on' : ''}`, () => {
      historyKind = kind
      renderFilters()
      loadHistory()
    })
    chipButton.setAttribute('aria-pressed', String(kind === historyKind))
    return chipButton
  }))
}

function eventCard(event, date) {
  const card = el('article', 'event')
  const top = el('div', 'event-top')
  const stamp = el('time', 'event-time', when(date))
  stamp.dateTime = date.toISOString()
  top.append(el('span', `badge ${KIND_BADGE[event.kind] || ''}`, KIND_LABEL[event.kind] || event.kind), el('strong', 'event-client', event.clientName), stamp)
  card.append(top)
  if (event.text) {
    const flat = event.text.replace(/\s+/g, ' ').trim()
    const clipped = flat.length > 140 ? `${flat.slice(0, 139).trimEnd()}…` : flat
    card.append(el('p', 'event-text', `${event.service ? `[${event.service}] ` : ''}${clipped}`))
  }
  if (event.comment) card.append(el('p', 'event-comment', `${COMMENT_LEAD[event.kind] || ''}"${event.comment}"`))
  return card
}

async function loadHistory() {
  const list = $('history-list')
  try {
    const { events } = await api(`/api/history${historyKind ? `?kind=${encodeURIComponent(historyKind)}` : ''}`)
    if (!events.length) {
      list.replaceChildren(el('div', 'empty', historyKind
        ? 'Nothing like that yet.'
        : 'Nothing yet. Approvals, change requests and updates will appear here as they happen.'))
      return
    }
    const nodes = []
    let lastDay = ''
    for (const event of events) {
      const date = new Date(event.at)
      const label = dayLabel(date)
      if (label !== lastDay) {
        nodes.push(el('h3', 'day', label))
        lastDay = label
      }
      nodes.push(eventCard(event, date))
    }
    list.replaceChildren(...nodes)
  } catch (err) {
    list.replaceChildren(el('p', 'hint', err.message))
  }
}

/* ------------------------------------------------------ where you are */
// Three places, each with its own address so the browser's Back button works:
//   (nothing)  your clients
//   #account   your account, preferences, notifications, permissions
//   #history   the History tab inside Account
function route() {
  const view = location.hash === '#account' ? 'account' : location.hash === '#history' ? 'history' : 'clients'
  currentTab = view
  const onHistory = view === 'history'
  $('view-clients').hidden = view !== 'clients'
  $('view-account').hidden = view === 'clients'
  $('panel-account').hidden = onHistory
  $('panel-history').hidden = !onHistory
  $('tab-account').setAttribute('aria-selected', String(!onHistory))
  $('tab-history').setAttribute('aria-selected', String(onHistory))
  if (onHistory) {
    renderFilters()
    loadHistory()
  }
  window.scrollTo(0, 0)
}
window.addEventListener('hashchange', route)
$('tab-account').addEventListener('click', () => { location.hash = '#account' })
$('tab-history').addEventListener('click', () => { location.hash = '#history' })

/* --------------------------------------------------------------- account */

const SCOPE_TEXT = {
  'account:read': 'See your name and Buffer organization',
  'posts:read': 'Read your drafts and scheduled posts',
  'posts:write': 'Create a tag for each client',
  'ideas:read': 'Read your Ideas',
  'ideas:write': "Add your clients' content as Ideas",
  'notes:read': 'Read notes on your posts',
  'notes:write': 'Add approvals and change requests as notes on your posts',
  offline_access: 'Keep working for your clients while you are away',
}

function segmented(container, options, current, onPick) {
  const render = (value) => container.replaceChildren(...options.map(([key, label]) => {
    const choice = button(label, '', () => {
      onPick(key)
      render(key)
    })
    choice.setAttribute('aria-pressed', String(key === value))
    return choice
  }))
  render(current)
}

let connectedAt = null
function showConnectedAt() {
  $('acct-since').textContent = connectedAt ? when(connectedAt) : 'Just now'
}

function renderAccount(session) {
  const { account } = session
  $('acct-name').textContent = account.name || 'Not set'
  $('acct-email').textContent = account.email || 'Not set'
  $('acct-org').textContent = (account.organizations || []).map((o) => o.name).join(', ') || 'Not set'
  connectedAt = session.connectedAt
  showConnectedAt()
  $('avatar').textContent = (account.name || account.email || '?').trim().charAt(0)
  $('permissions').replaceChildren(...String(session.scope || '').split(/\s+/).filter(Boolean)
    .map((scope) => el('li', '', SCOPE_TEXT[scope] || scope)))
  segmented($('pref-theme'), [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']], themePref, applyTheme)
  segmented($('pref-time'), [['auto', 'Auto'], ['12', '12-hour'], ['24', '24-hour']], timePref, (value) => {
    timePref = value
    writePref(PREF_TIME, value)
    showConnectedAt()
    refresh() // dates on screen change straight away
  })
}

/* ---------------------------------------------------------- live updates */
// No refreshing needed. Every few seconds the page asks a tiny question, "has
// anything changed?", and redraws only when the answer is yes. A notification
// arriving redraws it at once. It never redraws over something you are typing.

function editing() {
  const active = document.activeElement
  return Boolean(
    document.querySelector('#view-clients [data-editing]') ||
    (active && active.closest('#clients') && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)) ||
    $('client-name').value,
  )
}

async function refresh() {
  await loadOverview()
  if (currentTab === 'history') await loadHistory()
}

let seenPulse = null
async function checkForChanges() {
  if (document.hidden || editing()) return
  try {
    const { pulse } = await api('/api/overview/pulse')
    const first = seenPulse === null
    if (pulse !== seenPulse) {
      seenPulse = pulse
      if (!first) await refresh()
    }
  } catch {
    // A dropped connection: try again on the next tick.
  }
}

function startLiveUpdates() {
  checkForChanges()
  setInterval(checkForChanges, 5000)
  // Every minute, a full look as well: it also notices changes made in Buffer.
  setInterval(() => { if (!document.hidden && !editing()) refresh() }, 60_000)
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !editing()) refresh() })
  navigator.serviceWorker?.addEventListener('message', (event) => {
    if (event.data?.type === 'refresh' && !editing()) refresh()
  })
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
  renderAccount(session)
  setupNotifications().catch(() => {
    // The browser could not start notifications: say so, rather than showing an empty box.
    $('notify-text').textContent = 'Notifications are not available in this browser right now. Try a regular (non-private) window, or another browser.'
    $('notify-toggle').hidden = true
    $('nudge').hidden = true
  })
  await loadOverview()
  route()
  startLiveUpdates()
}

$('logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' })
  location.reload()
})

start().catch((err) => {
  showError(err.message)
  $('connect').hidden = false
})
