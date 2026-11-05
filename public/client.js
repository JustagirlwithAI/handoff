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
