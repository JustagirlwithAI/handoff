const $ = (id) => document.getElementById(id)
const banner = $('banner')

function showError(message) {
  banner.textContent = message
  banner.hidden = !message
}

function option(value, label, service = null) {
  const element = document.createElement('option')
  element.value = value
  element.textContent = label
  if (service) element.dataset.service = service
  return element
}

// Channel names and API messages are remote data, so everything is built with
// DOM APIs and textContent rather than innerHTML. A test enforces this.
function setMessage(element, lines) {
  element.replaceChildren()
  lines.forEach((line, index) => {
    if (index) element.append(document.createElement('br'))
    element.append(typeof line === 'string' ? document.createTextNode(line) : line)
  })
}

// The page never handles a Buffer token: it calls this app's own endpoints and
// the server attaches the token. Errors arrive as { error } with an HTTP status.
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

async function loadChannels(organizationId) {
  const channel = $('channel')
  channel.replaceChildren(option('', 'Loading…'))

  const { channels } = await api(`/api/channels?organizationId=${encodeURIComponent(organizationId)}`)
  if (!channels.length) {
    channel.replaceChildren(option('', 'No connected channels'))
    return
  }
  channel.replaceChildren(...channels.map((c) => {
    const paused = c.isQueuePaused ? ' — queue paused' : ''
    return option(c.id, `${c.displayName || c.name} (${c.service})${paused}`, c.service)
  }))
  describeChannel()
}

// Some networks will not publish a post that carries no media, so say so as
// soon as the channel is picked rather than after the API refuses it.
const MEDIA_FIRST = { instagram: 'Instagram', pinterest: 'Pinterest', tiktok: 'TikTok', youtube: 'YouTube' }

function selectedService() {
  const channel = $('channel')
  return channel.options[channel.selectedIndex]?.dataset.service || ''
}

function describeChannel() {
  const network = MEDIA_FIRST[selectedService()]
  const hint = $('media-hint')
  hint.textContent = network ? `${network} posts need an image or video.` : ''
  hint.hidden = !network
}

$('channel').addEventListener('change', describeChannel)

async function start() {
  const session = await api('/api/session')

  if (!session.connected) {
    $('connect').hidden = false
    return
  }

  $('app').hidden = false
  const { account } = session
  $('account').textContent = `Connected as ${account.name || account.email}`

  const grant = $('grant')
  grant.textContent = 'Your Buffer connection is stored encrypted on the server so client links keep working after you sign out. It renews automatically.'
  grant.hidden = false

  const organization = $('organization')
  organization.replaceChildren(...account.organizations.map((o) => option(o.id, o.name)))
  organization.disabled = account.organizations.length === 1

  organization.addEventListener('change', () => {
    loadChannels(organization.value).catch((err) => showError(err.message))
  })
  await loadChannels(organization.value)
  await loadClients()
}

$('form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const submit = $('submit')
  const result = $('result')
  showError('')
  submit.disabled = true
  submit.textContent = 'Working…'

  try {
    const { post } = await api('/api/posts', {
      method: 'POST',
      body: JSON.stringify({
        channelId: $('channel').value,
        organizationId: $('organization').value,
        text: $('text').value,
        mediaUrl: $('media').value,
      }),
    })

    result.className = 'result ok'
    const details = document.createElement('code')
    details.textContent = `post ${post.id} · status ${post.status}`
    const link = document.createElement('a')
    link.href = 'https://publish.buffer.com'
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.textContent = 'Open Buffer'
    setMessage(result, ['A post draft is created.', details, link])
    $('text').value = ''
    $('media').value = ''
  } catch (err) {
    result.className = 'result bad'
    result.textContent = err.message
  } finally {
    result.hidden = false
    submit.disabled = false
    submit.textContent = 'Add draft to queue'
  }
})

/* ---------------------------------------------------------------- clients */

// Shows a freshly made link once, with a Copy button. The server keeps only a
// fingerprint of it, so this is the only time it can be displayed.
function showLink(name, link) {
  const box = $('client-link')
  box.className = 'result ok'
  const input = document.createElement('input')
  input.type = 'text'
  input.readOnly = true
  input.value = link
  input.addEventListener('focus', () => input.select())
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'btn'
  copy.textContent = 'Copy link'
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(link)
      copy.textContent = 'Copied!'
    } catch {
      input.select()
      copy.textContent = 'Press Ctrl+C to copy'
    }
  })
  setMessage(box, [`Private link for ${name}. Copy it now. It can't be shown again, but you can always make a new one.`, input, copy])
  box.hidden = false
}

function clientRow(client) {
  const item = document.createElement('li')
  const label = document.createElement('span')
  label.textContent = client.name
  const renew = document.createElement('button')
  renew.type = 'button'
  renew.className = 'link'
  renew.textContent = 'New link'
  renew.title = 'Makes a new link. The old one stops working.'
  renew.addEventListener('click', async () => {
    if (!confirm(`Make a new link for ${client.name}? The old link will stop working.`)) return
    try {
      const { link } = await api(`/api/clients/${client.id}/link`, { method: 'POST' })
      showLink(client.name, link)
    } catch (err) {
      showError(err.message)
    }
  })
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'link'
  remove.textContent = 'Delete'
  remove.addEventListener('click', async () => {
    if (!confirm(`Delete ${client.name}? Their link will stop working.`)) return
    try {
      await api(`/api/clients/${client.id}`, { method: 'DELETE' })
      await loadClients()
    } catch (err) {
      showError(err.message)
    }
  })
  item.append(label, renew, remove)
  return item
}

async function loadClients() {
  const list = $('client-list')
  try {
    const { clients } = await api('/api/clients')
    if (!clients.length) {
      const empty = document.createElement('li')
      empty.className = 'hint'
      empty.textContent = 'No clients yet.'
      list.replaceChildren(empty)
      return
    }
    list.replaceChildren(...clients.map(clientRow))
  } catch (err) {
    const problem = document.createElement('li')
    problem.className = 'hint'
    problem.textContent = err.message
    list.replaceChildren(problem)
  }
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
    await loadClients()
  } catch (err) {
    showError(err.message)
  } finally {
    add.disabled = false
  }
})

$('note-test').addEventListener('click', async () => {
  const button = $('note-test')
  const out = $('note-result')
  showError('')
  button.disabled = true
  button.textContent = 'Testing…'
  try {
    const r = await api('/api/dev/note-test', {
      method: 'POST',
      body: JSON.stringify({ channelId: $('channel').value, organizationId: $('organization').value }),
    })
    out.className = r.notesWork ? 'result ok' : 'result bad'
    setMessage(out, [
      r.notesWork ? 'Notes WORK on this plan.' : 'Notes did NOT work. Fall back to storing feedback in our database.',
      ...r.steps.map((s) => `${s.ok ? '✔' : '✘'} ${s.step}: ${s.detail}`),
    ])
  } catch (err) {
    out.className = 'result bad'
    out.textContent = err.message
  } finally {
    out.hidden = false
    button.disabled = false
    button.textContent = 'Test Notes on a draft'
  }
})

$('logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' })
  location.reload()
})

start().catch((err) => {
  showError(err.message)
  $('connect').hidden = false
})
