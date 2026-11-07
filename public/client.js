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
  const res = await fetch(api(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status})`)
  return data
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
  const res = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(sig.cloudName)}/image/upload`, {
    method: 'POST',
    body: form,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.secure_url) throw new Error(`Could not upload ${file.name}. ${data.error?.message || ''}`.trim())
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

const STATUS_TEXT = {
  waiting: 'Waiting for your answer',
  approved: 'You approved this',
  changes: 'You asked for changes',
}

function reviewCard(share) {
  const card = document.createElement('div')
  card.className = 'card'

  const head = document.createElement('div')
  head.className = 'card-head'
  const where = document.createElement('span')
  where.className = 'hint'
  where.textContent = [share.post.service, share.post.channel].filter(Boolean).join(' · ')
  const badge = document.createElement('span')
  badge.className = `badge ${share.status}`
  badge.textContent = STATUS_TEXT[share.status] || share.status
  head.append(where, badge)

  const body = document.createElement('p')
  body.className = 'post-text'
  body.textContent = share.post.text || '(No text)'
  // After a revision, say what changed so the client knows what to look at.
  card.append(head)
  if (share.updated && share.status === 'waiting') {
    const update = document.createElement('p')
    update.className = 'update-note'
    update.textContent = share.managerNote
      ? `Updated version. From your manager: ${share.managerNote}`
      : 'Updated version. Please take another look.'
    card.append(update)
  }
  card.append(body)

  // When it is planned to go out, so the client can judge the timing too.
  const when = document.createElement('p')
  when.className = 'hint'
  const due = share.post.dueAt ? new Date(share.post.dueAt) : null
  when.textContent = due && !Number.isNaN(due.getTime())
    ? `Planned for ${due.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
    : 'Not scheduled yet'

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
  card.append(when)

  if (share.feedback) {
    const said = document.createElement('p')
    said.className = 'feedback'
    said.textContent = `Your note: "${share.feedback}"`
    card.append(said)
  }

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
      if (decision === 'approved') {
        showReviewNote('Approved. Thank you! Your manager has been told.')
        // Nothing left to decide? Take them straight to sending something new.
        if (!$('review-list').querySelector(':scope > .card')) {
          $('welcome').scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      } else {
        showReviewNote('Sent. Your manager will see your changes.')
      }
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

  // Once approved, the post folds away into one line so the page can focus on
  // what still needs an answer. Tapping the line opens it again.
  if (share.status !== 'approved') return card
  const folded = document.createElement('details')
  folded.className = 'folded'
  const line = document.createElement('summary')
  const flat = (share.post.text || '').replace(/\s+/g, ' ').trim()
  const preview = flat.length > 60 ? `${flat.slice(0, 59).trimEnd()}…` : flat
  line.textContent = `✓ Approved · ${[share.post.service, preview].filter(Boolean).join(' · ')}`
  folded.append(line, card)
  return folded
}

async function loadReviews() {
  const res = await fetch(api('/shares'))
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Could not load your posts.')
  $('review').hidden = data.shares.length === 0
  // Posts that still need an answer first, approved ones last.
  const order = { waiting: 0, changes: 1, approved: 2 }
  const shares = [...data.shares].sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3))
  $('review-list').replaceChildren(...shares.map(reviewCard))

  const open = shares.filter((s) => s.status !== 'approved').length
  $('review-sub').textContent = open
    ? `You have ${open} post${open > 1 ? 's' : ''} to look at.`
    : 'You are all caught up. Approved posts are folded away below.'
}

let noteTimer
function showReviewNote(message) {
  const note = $('review-note')
  note.textContent = message
  note.hidden = false
  clearTimeout(noteTimer)
  noteTimer = setTimeout(() => { note.hidden = true }, 6000)
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
  $('welcome').hidden = false
  await loadReviews().catch(() => {})
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
  try {
    const photos = []
    for (const file of files) photos.push(await uploadPhoto(file))
    send.textContent = 'Sending…'
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
    showResult(true, 'Sent! Your manager has received it. You can send another one any time.')
  } catch (err) {
    showResult(false, err.message)
  } finally {
    send.disabled = false
    send.textContent = 'Send'
  }
})

start().catch(() => {
  $('sub').textContent = ''
  showBanner('Something went wrong. Please try again.')
})
