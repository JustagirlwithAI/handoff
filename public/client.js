const $ = (id) => document.getElementById(id)

// The link looks like /c/<token>. The token is sent to our server, which looks
// it up and answers with the one client it belongs to.
const token = location.pathname.split('/')[2] || ''
const api = (path) => `/api/public/${encodeURIComponent(token)}${path}`

const MAX_PHOTOS = 4
const MAX_PHOTO_BYTES = 8 * 1024 * 1024
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

function showBanner(message) {
  $('banner').textContent = message
  $('banner').hidden = !message
}

async function post(path, body) {
  let res
  try {
    res = await fetch(api(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    // No reply at all: the browser calls this "Failed to fetch". Say it in plain words.
    const err = new Error("We couldn't reach Handoff. Please check your connection and try again.")
    err.noReply = true
    throw err
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status})`)
  return data
}

// Date and time in the reader's own time zone, e.g. "Nov 10, 3:42 PM".
function when(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleString(undefined, {
    month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), hour: 'numeric', minute: '2-digit',
  })
}

// Sends one photo straight to Cloudinary using a one-time signature from us.
async function uploadPhoto(file) {
  const sig = await post('/upload-signature', {})
  const form = new FormData()
  form.append('file', file)
  form.append('api_key', sig.apiKey)
  form.append('timestamp', sig.timestamp)
  form.append('signature', sig.signature)
  form.append('folder', sig.folder)
  form.append('allowed_formats', sig.allowed_formats)
  const failed = `We couldn't upload "${file.name}". Nothing was sent, and your words are still here. Check your connection, then press Send to try again (a smaller photo helps too).`
  let res
  try {
    res = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(sig.cloudName)}/image/upload`, {
      method: 'POST',
      body: form,
    })
  } catch {
    throw new Error(failed)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.secure_url) throw new Error(failed)
  return data.secure_url
}

function checkPhotos(files) {
  if (files.length > MAX_PHOTOS) return `Please choose up to ${MAX_PHOTOS} photos.`
  for (const file of files) {
    if (!PHOTO_TYPES.includes(file.type)) return `${file.name} is not a JPG, PNG, WebP or GIF image.`
    if (file.size > MAX_PHOTO_BYTES) return `${file.name} is larger than 8 MB.`
  }
  return ''
}

function showResult(ok, message) {
  const box = $('f-result')
  box.className = ok ? 'result ok' : 'result bad'
  box.textContent = message
  box.hidden = false
}

/* ------------------------------------------------------------- reviewing */
// The page shows only posts that still need an answer. Once the client approves
// or asks for changes, the post leaves their screen (the manager keeps the record).

function reviewCard(share) {
  const card = document.createElement('div')
  card.className = 'card'

  const head = document.createElement('div')
  head.className = 'card-head'
  const where = document.createElement('span')
  where.className = 'hint'
  where.textContent = [share.post.service, share.post.channel].filter(Boolean).join(' · ')
  const badge = document.createElement('span')
  badge.className = 'badge waiting'
  badge.textContent = 'Waiting for your answer'
  head.append(where, badge)
  card.append(head)

  // When it arrived, and after a revision, what changed.
  const sent = document.createElement('p')
  sent.className = 'hint'
  sent.textContent = `${share.updated ? 'Updated version sent' : 'Sent to you'} ${when(share.sentAt)}`
  card.append(sent)
  if (share.updated) {
    const update = document.createElement('p')
    update.className = 'update-note'
    update.textContent = share.managerNote
      ? `From your manager: ${share.managerNote}`
      : 'Your manager revised this post. Please take another look.'
    card.append(update)
  }

  const body = document.createElement('p')
  body.className = 'post-text'
  body.textContent = share.post.text || '(No text)'
  card.append(body)

  if (share.post.images?.length) {
    const images = document.createElement('div')
    images.className = 'images'
    for (const image of share.post.images) {
      if (!/^https:\/\//i.test(image.url)) continue
      const img = document.createElement('img')
      img.src = image.url
      img.alt = ''
      img.loading = 'lazy'
      img.referrerPolicy = 'no-referrer'
      images.append(img)
    }
    card.append(images)
  }

  // When it is planned to go out, so the client can judge the timing too.
  const plan = document.createElement('p')
  plan.className = 'hint'
  const due = share.post.dueAt ? new Date(share.post.dueAt) : null
  plan.textContent = due && !Number.isNaN(due.getTime()) ? `Planned for ${when(due)}` : 'Not scheduled yet'
  card.append(plan)

  const comment = document.createElement('textarea')
  comment.rows = 3
  comment.maxLength = 1000
  comment.placeholder = 'What should change? (required for "Request changes", optional for "Approve")'
  const message = document.createElement('div')
  message.className = 'result'
  message.hidden = true

  const actions = document.createElement('div')
  actions.className = 'actions'
  const approve = document.createElement('button')
  approve.type = 'button'
  approve.className = 'btn'
  approve.textContent = 'Approve'
  const changes = document.createElement('button')
  changes.type = 'button'
  changes.className = 'btn secondary'
  changes.textContent = 'Request changes'

  const decide = async (decision) => {
    approve.disabled = changes.disabled = true
    message.hidden = true
    try {
      await post(`/shares/${encodeURIComponent(share.id)}/decision`, { decision, comment: comment.value })
      await loadReviews()
      showReviewNote(decision === 'approved'
        ? 'Approved. Thank you! Your manager has been told.'
        : 'Sent. Your manager will see your changes.')
      // Nothing left to answer? Go straight to sending something new.
      if (!$('review-list').children.length) $('welcome').scrollIntoView({ behavior: 'smooth', block: 'start' })
    } catch (err) {
      message.className = 'result bad'
      message.textContent = err.message
      message.hidden = false
      approve.disabled = changes.disabled = false
    }
  }
  approve.addEventListener('click', () => decide('approved'))
  changes.addEventListener('click', () => decide('changes'))
  actions.append(approve, changes)
  card.append(comment, actions, message)
  return card
}

async function loadReviews() {
  const res = await fetch(api('/shares'))
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Could not load your posts.')
  const count = data.shares.length
  // A "working client" has sent their first content, or been shared a draft. A
  // brand-new client has done neither, and sees only the content form.
  const isWorking = Boolean(data.everShared || data.everSubmitted)
  $('review').hidden = count === 0
  // Say plainly why the list is empty.
  $('review-empty').hidden = !(isWorking && count === 0)
  $('review-empty').textContent = data.everShared
    ? "You're all caught up. Nothing needs your answer right now."
    : 'Nothing to review yet. When your manager shares a draft with you, it will appear here.'
  $('review-list').replaceChildren(...data.shares.map(reviewCard))
  $('review-sub').textContent = `You have ${count} post${count === 1 ? '' : 's'} to look at.`
  // The tab says how many posts need their answer.
  $('tab-count').hidden = count === 0
  $('tab-count').textContent = String(count)
  applyLayout(isWorking)
}

// The page has two looks.
//  - A NEW client (has sent nothing, been shown nothing): just the full content
//    form, no tabs. That is the one thing to do.
//  - A WORKING client: the tabs (To review, History), with the form folded into the
//    "Send additional content" drop-down so the review gets the attention.
// A client becomes a working client the moment they send their first content.
let working = null
function applyLayout(isWorking) {
  const box = $('send-box')
  const first = working === null
  const changed = working !== isWorking
  working = isWorking
  $('tabs').hidden = !isWorking
  if (!isWorking && currentView === 'history') location.hash = '' // History does not exist yet
  $('send-title').textContent = isWorking ? 'Send additional content for a post' : 'Send content for a post'
  $('send-sub').textContent = isWorking
    ? 'More ideas, links or details you did not include before'
    : "Tell your social media manager what you'd like posted. No account needed."
  box.classList.toggle('static', !isWorking) // new client: no fold arrow, cannot be collapsed
  if (!isWorking) {
    box.open = true
  } else if (changed) {
    // They just became a working client. Fold the form away, unless they are mid-way through writing.
    const typed = [...box.querySelectorAll('input:not([type=file]), textarea')].some((field) => field.value)
    if (first || !typed) box.open = false
  }
}
$('send-box').querySelector('summary').addEventListener('click', (event) => {
  if ($('send-box').classList.contains('static')) event.preventDefault()
})

let noteTimer
function showReviewNote(message) {
  const note = $('review-note')
  note.textContent = message
  note.hidden = false
  clearTimeout(noteTimer)
  noteTimer = setTimeout(() => { note.hidden = true }, 6000)
}

/* --------------------------------------------------------------- history */
// The client's own record, the same way the manager has one: what was sent to
// them, what they approved or asked about, and what they sent. Each entry opens
// to show exactly what it contained.

const KIND_LABEL = {
  shared: 'Sent to you',
  updated: 'Updated version received',
  approved: 'You approved',
  changes: 'You asked for changes',
  submitted: 'You sent content',
}
const KIND_BADGE = { shared: '', updated: 'waiting', approved: 'approved', changes: 'changes', submitted: '' }
const COMMENT_LEAD = { approved: 'You added: ', changes: 'You asked: ', updated: 'What changed: ' }
const DETAIL_LABEL = {
  shared: 'What was sent to you',
  updated: 'The updated version',
  approved: 'What you approved',
  changes: 'The post you asked changes on',
  submitted: 'What you sent',
}
const FILTERS = [['', 'All'], ['approved', 'Approved'], ['changes', 'Changes I asked for']]

let currentView = 'home'
let historyKind = ''

const isHttps = (url) => typeof url === 'string' && /^https:\/\//i.test(url)

function node(tag, className, text) {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

function dayLabel(date) {
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diff = Math.round((day(new Date()) - day(date)) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

function photos(urls) {
  const wrap = node('div', 'images')
  for (const url of urls.filter(isHttps)) {
    const img = node('img')
    img.src = url
    img.alt = ''
    img.loading = 'lazy'
    img.referrerPolicy = 'no-referrer'
    wrap.append(img)
  }
  return wrap
}

function eventDetail(d) {
  const nodes = [node('p', 'detail-label', DETAIL_LABEL[d.kind] || 'Details')]
  const box = node('div', 'detail-post')
  const p = d.post
  if (d.kind === 'submitted') {
    const list = node('dl', 'kv')
    for (const [label, value] of [['Title', p.title], ['Post text', p.text], ['Extra details', p.details], ['Timing notes', p.timing], ['Preferred date', p.date]]) {
      if (!value) continue
      list.append(node('dt', '', label), node('dd', 'pre', String(value)))
    }
    box.append(list)
    if ((p.photos || []).some(isHttps)) box.append(photos(p.photos))
  } else {
    const where = [p.service, p.channel].filter(Boolean).join(' · ')
    if (where) box.append(node('p', 'hint', where))
    box.append(node('p', 'post-text', p.text || '(No text)'))
    const urls = (p.images || []).map((i) => i.url)
    if (urls.some(isHttps)) box.append(photos(urls))
    const due = p.dueAt ? new Date(p.dueAt) : null
    box.append(node('p', 'hint', due && !Number.isNaN(due.getTime()) ? `Planned for ${when(due)}` : 'Not scheduled'))
  }
  nodes.push(box)
  if (d.comment && d.kind !== 'submitted') nodes.push(node('p', 'event-comment', `${COMMENT_LEAD[d.kind] || ''}"${d.comment}"`))
  if (!d.exact) nodes.push(node('p', 'hint', 'This is an older entry. Its exact wording at that moment was not saved.'))
  return nodes
}

function eventCard(event, date) {
  const card = node('details', 'event')
  const summary = node('summary')
  const top = node('div', 'event-top')
  const stamp = node('time', 'event-time', when(date))
  stamp.dateTime = date.toISOString()
  top.append(node('span', `badge ${KIND_BADGE[event.kind] || ''}`, KIND_LABEL[event.kind] || event.kind), stamp)
  summary.append(top)
  if (event.text) {
    const flat = event.text.replace(/\s+/g, ' ').trim()
    summary.append(node('p', 'event-text', `${event.service ? `[${event.service}] ` : ''}${flat.length > 140 ? `${flat.slice(0, 139).trimEnd()}…` : flat}`))
  }
  if (event.comment) summary.append(node('p', 'event-comment', `${COMMENT_LEAD[event.kind] || ''}"${event.comment}"`))
  card.append(summary)

  const detail = node('div', 'event-detail')
  card.append(detail)
  let loaded = false
  card.addEventListener('toggle', async () => {
    if (!card.open || loaded) return
    loaded = true
    detail.replaceChildren(node('p', 'hint', 'Loading…'))
    try {
      const res = await fetch(api(`/history/${encodeURIComponent(event.id)}`))
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not load this entry.')
      detail.replaceChildren(...eventDetail(data))
    } catch (err) {
      loaded = false
      detail.replaceChildren(node('p', 'hint', err.message))
    }
  })
  return card
}

function renderFilters() {
  $('history-filters').replaceChildren(...FILTERS.map(([kind, label]) => {
    const chip = node('button', `filter${kind === historyKind ? ' on' : ''}`, label)
    chip.type = 'button'
    chip.setAttribute('aria-pressed', String(kind === historyKind))
    chip.addEventListener('click', () => {
      historyKind = kind
      renderFilters()
      loadHistory()
    })
    return chip
  }))
}

async function loadHistory() {
  const list = $('history-list')
  try {
    const res = await fetch(api(`/history${historyKind ? `?kind=${encodeURIComponent(historyKind)}` : ''}`))
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'Could not load your history.')
    if (!data.events.length) {
      list.replaceChildren(node('p', 'tip empty-line', historyKind ? 'Nothing like that yet.' : 'Nothing here yet. Posts you review, and content you send, will be listed here.'))
      return
    }
    const nodes = []
    let lastDay = ''
    for (const event of data.events) {
      const date = new Date(event.at)
      const label = dayLabel(date)
      if (label !== lastDay) {
        nodes.push(node('h3', 'day', label))
        lastDay = label
      }
      nodes.push(eventCard(event, date))
    }
    list.replaceChildren(...nodes)
  } catch (err) {
    list.replaceChildren(node('p', 'hint', err.message))
  }
}

// Two places on this page, each with its own address so Back works:
// (nothing) the posts to review, and #history.
function route() {
  // A new client has no History yet, so only the home view exists for them.
  currentView = location.hash === '#history' && working !== false ? 'history' : 'home'
  const onHistory = currentView === 'history'
  $('view-home').hidden = onHistory
  $('view-history').hidden = !onHistory
  $('tab-home').setAttribute('aria-selected', String(!onHistory))
  $('tab-history').setAttribute('aria-selected', String(onHistory))
  if (onHistory) {
    renderFilters()
    loadHistory()
  }
}
window.addEventListener('hashchange', route)
$('tab-home').addEventListener('click', () => { location.hash = '' })
$('tab-history').addEventListener('click', () => { location.hash = '#history' })

/* ---------------------------------------------------------- live updates */
// No refreshing needed. Every few seconds the page asks a tiny question, "has
// anything changed?", and reloads its posts only when the answer is yes. A
// notification arriving also refreshes it at once.

// Do not redraw while the client is in the middle of writing a comment.
function typing() {
  return [...$('review-list').querySelectorAll('textarea')].some((t) => t.value || t === document.activeElement)
}

// Reload what is on screen: the posts to review, and the History if that tab is open
// (but never collapse a History entry the client is reading).
async function refresh() {
  await loadReviews().catch(() => {})
  if (currentView === 'history' && !document.querySelector('#history-list details[open]')) await loadHistory()
}

let seenPulse = null
async function checkForChanges() {
  if (document.hidden || typing()) return
  try {
    const res = await fetch(api('/pulse'))
    if (!res.ok) return
    const { pulse } = await res.json()
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
  setInterval(() => { if (!document.hidden && !typing()) refresh() }, 60_000)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !typing()) refresh()
  })
  navigator.serviceWorker?.addEventListener('message', (event) => {
    if (event.data?.type === 'refresh' && !typing()) refresh()
  })
}

/* --------------------------------------------------------- notifications */
// So the client hears about a new or updated post without needing any chat app
// or email: one tap here, and their device shows a notification when it is ready.

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
  box.hidden = false

  if (!pushSupported()) {
    text.textContent = 'To get a notification when a post is ready, open this page from your browser on a computer or Android phone. On an iPhone, tap Share and choose Add to Home Screen first.'
    toggle.hidden = true
    return
  }

  const registration = await navigator.serviceWorker.register('/sw.js')
  // Lets a tapped notification bring them back to this page.
  const ready = await navigator.serviceWorker.ready
  ready.active?.postMessage({ type: 'client-path', path: location.pathname })

  const render = async () => {
    const current = await registration.pushManager.getSubscription()
    const blocked = Notification.permission === 'denied'
    toggle.hidden = blocked
    toggle.disabled = false
    if (blocked) text.textContent = 'Notifications are blocked for this site. Allow them in your browser settings, then reload this page.'
    else if (current) text.textContent = '🔔 You will get a notification when a post is ready.'
    else text.textContent = 'Want a heads-up when a post is ready for you? Turn on notifications.'
    toggle.textContent = current ? 'Turn off' : 'Notify me'
    toggle.className = current ? 'link' : 'btn small'
  }

  toggle.addEventListener('click', async () => {
    toggle.disabled = true
    try {
      const current = await registration.pushManager.getSubscription()
      if (current) {
        await post('/push/off', { endpoint: current.endpoint })
        await current.unsubscribe()
      } else {
        if ((await Notification.requestPermission()) !== 'granted') return
        const keyRes = await fetch(api('/push-key'))
        const { publicKey } = await keyRes.json()
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyToBytes(publicKey),
        })
        await post('/push', subscription.toJSON())
      }
    } catch (err) {
      showBanner(`Could not change notifications: ${err.message}`)
    } finally {
      await render()
    }
  })

  await render()
}

async function start() {
  const res = await fetch(api(''))
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    $('sub').textContent = ''
    showBanner(body.error || 'This link is not valid.')
    return
  }
  $('title').textContent = `Hi, ${body.client.name}`
  $('sub').textContent = 'Your private page'
  document.title = `Handoff · ${body.client.name}`
  $('photo-label').hidden = !body.photosEnabled
  setupNotifications().catch(() => { $('notify').hidden = true })
  await loadReviews().catch(() => {})
  // Shown only now, so a returning client never sees a flash of the wrong layout.
  $('welcome').hidden = false
  route()
  startLiveUpdates()
}

$('f-photos').addEventListener('change', () => {
  const files = [...$('f-photos').files]
  $('photo-hint').textContent = checkPhotos(files) || (files.length ? `${files.length} photo${files.length > 1 ? 's' : ''} selected` : '')
})

$('submit-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const send = $('f-send')
  const files = $('photo-label').hidden ? [] : [...$('f-photos').files]
  const problem = checkPhotos(files)
  if (problem) return showResult(false, problem)

  send.disabled = true
  send.textContent = files.length ? 'Uploading photos…' : 'Sending…'
  $('f-result').hidden = true
  let sending = false
  try {
    const photos = []
    for (const file of files) photos.push(await uploadPhoto(file))
    send.textContent = 'Sending…'
    sending = true
    await post('/submissions', {
      title: $('f-title').value,
      text: $('f-text').value,
      details: $('f-details').value,
      timing: $('f-timing').value,
      date: $('f-date').value,
      photos,
    })
    $('submit-form').reset()
    $('photo-hint').textContent = ''
    showResult(true, 'Sent! Your manager has received it. You can send more any time.')
    // Sending content makes them a working client: the page switches to the tabs,
    // and the form becomes the drop-down, folded away again after each send.
    await loadReviews().catch(() => {})
    if (working) $('send-box').open = false
    route()
  } catch (err) {
    // The text itself was in flight when the reply went missing, so it may have arrived.
    showResult(false, err.noReply && sending
      ? "We're not sure this went through. Before sending again, open History or ask your manager. If it isn't there, press Send again: your words are still here."
      : err.message)
  } finally {
    send.disabled = false
    send.textContent = 'Send'
  }
})

start().catch(() => {
  $('sub').textContent = ''
  showBanner('Something went wrong. Please try again.')
})
