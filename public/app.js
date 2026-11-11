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

// A box at the top for something worth copying or sharing: a new link, or a
// ready-to-send reminder. It offers Copy, and the device's own share menu
// (WhatsApp, Telegram, Slack, email... Handoff does not pick an app for you).
function showCopyBox({ intro, value, copyLabel = 'Copy', share, extra = [] }) {
  const box = $('client-link')
  box.className = 'result ok'
  const input = el('input')
  input.type = 'text'
  input.readOnly = true
  input.value = value
  input.addEventListener('focus', () => input.select())
  const copy = button(copyLabel, 'btn', async () => {
    try {
      await navigator.clipboard.writeText(value)
      copy.textContent = 'Copied!'
    } catch {
      input.select()
      copy.textContent = 'Press Ctrl+C to copy'
    }
  })
  const buttons = [copy]
  if (navigator.share && share) {
    buttons.push(button('Share…', 'btn secondary', async () => {
      try {
        await navigator.share(share)
      } catch {
        // They closed the share menu: nothing to do.
      }
    }))
  }
  const actions = el('div', 'actions')
  actions.append(...buttons, ...extra)
  box.replaceChildren(closeButton(box), el('p', 'box-text', intro), input, actions)
  box.hidden = false
  scrollTo({ top: 0, behavior: 'smooth' })
}

// The little X in the corner of the box at the top, so it never lingers once you
// have copied or shared what it holds.
function closeButton(box) {
  const close = button('×', 'close', () => {
    box.hidden = true
    box.replaceChildren()
  })
  close.setAttribute('aria-label', 'Close')
  close.title = 'Close'
  return close
}

// Shows a freshly made link once. The server keeps only a fingerprint of it, so
// this is the only time it can be displayed.
function showLink(name, link, intro) {
  showCopyBox({
    intro: intro || `Private link for ${name}. Copy or share it now: it can't be shown again, but you can always make a new one.`,
    value: link,
    copyLabel: 'Copy link',
    share: {
      title: 'Your Handoff page',
      text: `Hi ${name}, here is your private page. You can send me content and approve posts there, with no account needed:`,
      url: link,
    },
  })
}

// A short message at the top, optionally with buttons.
function showNotice(message, buttons = []) {
  const box = $('client-link')
  box.className = 'result ok'
  const actions = el('div', 'actions')
  actions.append(...buttons)
  box.replaceChildren(closeButton(box), el('p', 'box-text', message), ...(buttons.length ? [actions] : []))
  box.hidden = false
  scrollTo({ top: 0, behavior: 'smooth' })
}

// "3 h ago" for recent moments, a full date and time for older ones.
function ago(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`
  return when(date)
}

/* ---------------------------------------------------------------- export */
// The full record for one client as a spreadsheet file (opens in Excel, Numbers
// or Google Sheets). Built here in the browser so dates use YOUR time zone.

function csvCell(value) {
  let text = value == null ? '' : String(value)
  // Stop a spreadsheet from treating text that starts with = + - @ as a formula.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function buildRecordCsv(record) {
  const rows = [
    [`Handoff record for ${record.client.name}`],
    [`Exported ${when(new Date())}`],
    [],
    ['Date', 'Time', 'Timestamp (UTC)', 'What happened', 'Channel', 'Post', 'Planned for', 'Request or note', 'Extra details', 'Timing notes', 'Photos'],
  ]
  for (const e of record.entries) {
    const date = new Date(e.at)
    const post = e.kind === 'submitted' ? [e.title, e.text].filter(Boolean).join('\n') : e.text
    rows.push([
      date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
      date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', ...(timePref === 'auto' ? {} : { hour12: timePref === '12' }) }),
      date.toISOString(),
      KIND_LABEL[e.kind] || e.kind,
      [e.service, e.channel].filter(Boolean).join(' · '),
      post,
      e.dueAt ? when(e.dueAt) : '',
      e.comment || '',
      e.details || '',
      e.timing || '',
      (e.photos || []).join(' '),
    ])
  }
  return `﻿${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`
}

async function exportRecord(clientId, name) {
  showError('')
  try {
    const record = await api(`/api/clients/${clientId}/record`)
    const blob = new Blob([buildRecordCsv(record)], { type: 'text/csv;charset=utf-8' })
    const link = el('a')
    const slug = name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'client'
    link.href = URL.createObjectURL(blob)
    link.download = `Handoff-${slug}-record-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
  } catch (err) {
    showError(err.message)
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
    // Straight after the link: which Buffer channels do you post to for them? A
    // one-time choice that makes "Share a draft" show their drafts first.
    client.channelIds = []
    const picker = channelPicker(client, {
      intro: `Which Buffer channels do you post to for ${client.name}? Choose them once, and Share a draft will show their drafts first.`,
      onDone: (saved) => {
        picker.replaceChildren(el('p', 'picker-intro', saved
          ? 'Channels saved. You can change them any time from their row.'
          : 'No problem. You can choose them any time from their row.'))
        loadOverview()
      },
    })
    $('client-link').append(el('hr', 'box-sep'), picker)
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
  const labels = el('span', 'labels')
  labels.append(el('span', `badge ${share.status}`, STATUS_LABEL[share.status] || share.status))
  if (share.status === 'changes' && share.editedAt) labels.append(el('span', 'badge ready', 'Edited in Buffer'))
  top.append(
    labels,
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
  if (share.feedback) item.append(el('div', 'feedback', `${share.status === 'changes' ? 'Changes requested' : 'Note'}: "${share.feedback}"`))
  if (share.status !== 'waiting' && share.noteSaved === false) {
    item.append(el('div', 'hint', 'Saved here, but the Buffer Note could not be added.'))
  }
  // Only a post the client asked changes on needs a "send updated version". A post
  // still waiting is kept in step with Buffer automatically.
  if (share.status === 'changes') item.append(updateControl(share, reload))
  return item
}

// After the client asked for changes and the post was revised in Buffer: one tap
// sends the new version to the client. Handoff notices the edit by itself, so there
// is nothing to refresh. An optional line can tell the client what changed.
function updateControl(share, reload) {
  const wrap = el('div', 'update')
  const send = async (note, trigger) => {
    // Handoff checks Buffer every minute. If it has not seen an edit, say so.
    if (!share.editedAt && !confirm("Handoff can't see an edit in Buffer yet, so the client would get the same version again.\n\nSend anyway?")) return
    trigger.disabled = true
    showError('')
    try {
      await api(`/api/shares/${share.id}/refresh`, { method: 'POST', body: JSON.stringify({ note }) })
      await reload()
    } catch (err) {
      showError(err.message)
      trigger.disabled = false
    }
  }
  const main = button('Send updated version', share.editedAt ? 'btn small' : 'link', () => send('', main))
  const withNote = button('Add a note first', 'link', () => {
    const note = el('input')
    note.type = 'text'
    note.maxLength = 300
    note.placeholder = 'What changed? (the client will see it)'
    note.setAttribute('aria-label', 'Note to the client')
    const go = button('Send', 'btn small', () => send(note.value, go))
    const cancel = button('Cancel', 'link', () => { delete wrap.dataset.editing; wrap.replaceChildren(main, withNote) })
    wrap.dataset.editing = '1' // the page will not redraw over a box you are typing in
    wrap.replaceChildren(note, go, cancel)
    note.focus()
  })
  wrap.append(main, withNote)
  return wrap
}

/* ------------------------------------------------------ client channels */
// The Buffer channels you post to for a client, chosen once (and changeable any
// time). They are how "Share a draft" knows which drafts to show first. Nothing is
// guessed from the words of a post: you write each post in your own words.

let channelCache = null
async function loadChannels() {
  if (channelCache && Date.now() - channelCache.at < 5 * 60_000) return channelCache.list
  const { channels } = await api('/api/channels')
  channelCache = { at: Date.now(), list: channels }
  return channels
}

function channelPicker(client, { intro, saveLabel = 'Save channels', skipLabel = 'Skip for now', onDone }) {
  const wrap = el('div', 'channel-picker')
  wrap.append(el('p', 'picker-intro', intro))
  const list = el('div', 'channel-list')
  list.append(el('p', 'tip', 'Loading your Buffer channels…'))
  const chosen = new Set(client.channelIds || [])

  const save = button(saveLabel, 'btn small', async () => {
    save.disabled = true
    showError('')
    try {
      const result = await api(`/api/clients/${client.id}/channels`, { method: 'POST', body: JSON.stringify({ channelIds: [...chosen] }) })
      client.channelIds = result.channelIds
      onDone(true)
    } catch (err) {
      showError(err.message)
      save.disabled = false
    }
  })
  const actions = el('div', 'actions')
  actions.append(save, button(skipLabel, 'link', () => onDone(false)))
  wrap.append(list, actions)

  loadChannels().then((channels) => {
    if (!channels.length) {
      list.replaceChildren(el('p', 'tip', 'No connected channels found in your Buffer account.'))
      save.disabled = true
      return
    }
    list.replaceChildren(...channels.map((channel) => {
      const option = el('label', 'channel-option')
      const box = el('input')
      box.type = 'checkbox'
      box.checked = chosen.has(channel.id)
      box.addEventListener('change', () => (box.checked ? chosen.add(channel.id) : chosen.delete(channel.id)))
      option.append(box, el('span', 'channel-name', channel.name), el('span', 'tip', channel.service))
      return option
    }))
  }).catch((err) => {
    list.replaceChildren(el('p', 'tip', err.message))
    save.disabled = true
  })
  return wrap
}

// What you see after "Share a draft": the client's channel drafts first, everything
// else folded under "Other drafts", and a search box. No draft is ever out of reach.
function draftPicker(client, drafts, reload, close) {
  const mine = new Set(client.channelIds || [])
  let query = ''
  let showOther = false

  const wrap = el('div', 'draft-picker')
  const head = el('div', 'picker-head')
  head.append(el('strong', '', `Share a draft with ${client.name}`), button('Cancel', 'link', close))
  const search = el('input')
  search.type = 'search'
  search.placeholder = 'Search your drafts'
  search.setAttribute('aria-label', 'Search your drafts')
  const list = el('div', 'draft-list')
  wrap.append(head, search, list)

  const row = (draft) => {
    const item = el('div', 'draft')
    const body = el('div', 'draft-body')
    const where = [draft.service, draft.channel].filter(Boolean).join(' · ')
    body.append(
      el('div', 'tip', `${where}${draft.createdAt ? ` · ${ago(draft.createdAt)}` : ''}`),
      el('div', 'draft-text', draft.text.replace(/\s+/g, ' ').trim() || '(no text)'),
    )
    const share = button('Share', 'btn small', async () => {
      share.disabled = true
      showError('')
      try {
        await api(`/api/clients/${client.id}/shares`, { method: 'POST', body: JSON.stringify({ postId: draft.id }) })
        await reload()
      } catch (err) {
        showError(err.message)
        share.disabled = false
      }
    })
    item.append(body, share)
    return item
  }

  const matches = (draft) => {
    const q = query.trim().toLowerCase()
    return !q || [draft.text, draft.channel, draft.service].some((field) => String(field || '').toLowerCase().includes(q))
  }

  const render = () => {
    if (!drafts.length) {
      list.replaceChildren(el('p', 'tip', 'No drafts to share yet. Create a draft in Buffer first, then come back.'))
      return
    }
    const found = drafts.filter(matches)
    const nodes = []
    if (mine.size) {
      const first = found.filter((d) => mine.has(d.channelId))
      const rest = found.filter((d) => !mine.has(d.channelId))
      nodes.push(el('div', 'picker-label', `For ${client.name}'s channels (${first.length})`))
      nodes.push(...(first.length ? first.map(row) : [el('p', 'tip', 'No drafts for their channels yet.')]))
      const open = showOther || query.trim() !== '' // a search never hides its results
      const toggle = el('div', 'picker-label spread')
      toggle.append(el('span', '', `Other drafts (${rest.length})`), button(open ? 'Hide' : 'Show', 'link', () => { showOther = !showOther; render() }))
      nodes.push(toggle)
      if (open) nodes.push(...(rest.length ? rest.map(row) : [el('p', 'tip', 'Nothing else.')]))
    } else {
      nodes.push(el('div', 'picker-label', `All drafts (${found.length}), newest first`))
      nodes.push(...(found.length ? found.map(row) : [el('p', 'tip', 'No drafts match your search.')]))
      nodes.push(el('p', 'tip', `Tip: use the Channels button on ${client.name} to see their drafts first.`))
    }
    list.replaceChildren(...nodes)
  }
  search.addEventListener('input', () => { query = search.value; render() })
  render()
  return wrap
}

// A visible "Share a draft" button on every client card. A draft reaches a client
// only when you choose it here: a draft is not always ready for a client to see.
function shareControl(client, reload) {
  const wrap = el('div', 'share-hand')
  const start = button('＋ Share a draft', 'btn small', async () => {
    start.disabled = true
    showError('')
    try {
      const { drafts } = await api('/api/drafts')
      const taken = new Set(client.shares.map((s) => s.postId))
      const close = () => { delete wrap.dataset.editing; wrap.replaceChildren(start); start.disabled = false }
      wrap.dataset.editing = '1' // the page will not redraw over a picker you are using
      wrap.replaceChildren(draftPicker(client, drafts.filter((d) => !taken.has(d.id)), reload, close))
    } catch (err) {
      showError(err.message)
      start.disabled = false
    }
  })
  start.title = `Pick a draft from Buffer to show ${client.name} for approval`
  wrap.append(start)
  return wrap
}

// Whether the client has looked at their page, and whether it was after the latest
// post was sent to them. That is what tells the manager a reminder is worth sending.
function seenText(client) {
  const opened = client.lastOpenedAt ? new Date(client.lastOpenedAt) : null
  const waiting = client.shares.filter((s) => s.status === 'waiting')
  if (!opened) return 'Has not opened their link yet'
  if (!waiting.length) return `Last opened ${ago(opened)}`
  const latestSent = Math.max(...waiting.map((s) => new Date(s.updatedAt || s.createdAt).getTime()))
  return opened.getTime() >= latestSent
    ? `Opened ${ago(opened)}, no answer yet`
    : `Last opened ${ago(opened)}, before the newest post`
}

// A reminder: sent to the client's device if they allowed notifications, and
// otherwise a ready message to send in whichever app suits them.
async function remind(client, reload) {
  showError('')
  try {
    const result = await api(`/api/clients/${client.id}/nudge`, { method: 'POST' })
    if (result.delivered) {
      showNotice(`Reminder sent to ${client.name}'s device.`)
    } else {
      showCopyBox({
        intro: `${client.name} has not turned on notifications, so nothing was sent to their device. Here is a message to send in whichever app suits them:`,
        value: result.message,
        copyLabel: 'Copy message',
        share: { text: result.message },
      })
    }
    await reload()
  } catch (err) {
    showError(err.message)
  }
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

  // The row you tap: name (with when they last opened their link), a count per
  // status, and a chevron.
  const summary = el('summary')
  const nameCell = el('span', 'client-name', client.name)
  nameCell.append(el('small', 'seen', seenText(client)))
  summary.append(nameCell)
  const chips = el('span', 'chips')
  for (const status of ['changes', 'waiting', 'approved']) {
    if (client.counts[status]) chips.append(chip(status, client.counts[status]))
    // right after "needs changes": how many of those are edited and ready to send
    if (status === 'changes' && client.counts.edited) chips.append(el('span', 'badge ready', `${client.counts.edited} ready to send`))
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
  if (client.counts.waiting) {
    actions.append(button('Remind', 'btn small secondary', () => remind(client, reload)))
  }
  if (client.counts.approved) {
    actions.append(button(`${client.counts.approved} approved in History`, 'link', () => { location.hash = '#history' }))
  }
  // The Buffer channels you post to for this client: chosen once, changeable any time.
  const channelEditor = el('div', 'channel-edit')
  actions.append(
    button(client.channelIds?.length ? `Channels (${client.channelIds.length})` : 'Choose channels', 'link', () => {
      if (channelEditor.childElementCount) {
        delete channelEditor.dataset.editing
        channelEditor.replaceChildren()
        return
      }
      channelEditor.dataset.editing = '1' // the page will not redraw over a choice in progress
      channelEditor.append(channelPicker(client, {
        intro: `Which Buffer channels do you post to for ${client.name}?`,
        saveLabel: 'Save',
        skipLabel: 'Cancel',
        onDone: (saved) => {
          delete channelEditor.dataset.editing
          channelEditor.replaceChildren()
          if (saved) reload()
        },
      }))
    }),
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
    button('Archive', 'link', async () => {
      if (!confirm(`Archive ${client.name}?\n\nTheir link stops working and they leave your list. Their history is kept, and you can export it or restore them any time under Archived.`)) return
      try {
        await api(`/api/clients/${client.id}/archive`, { method: 'POST' })
        showNotice(`${client.name} is archived.`, [button('Export record', 'btn small', () => exportRecord(client.id, client.name))])
        await reload()
      } catch (err) {
        showError(err.message)
      }
    }),
    el('span', 'spacer'),
    button('Delete client', 'link danger', async () => {
      if (!confirm(`Delete ${client.name} for good?\n\nTheir link stops working and their whole record is lost. If you might need the record later, Archive them instead.`)) return
      try {
        await api(`/api/clients/${client.id}`, { method: 'DELETE' })
        await reload()
      } catch (err) {
        showError(err.message)
      }
    }),
  )
  body.append(actions, channelEditor)
  card.append(body)
  return card
}

const HOW_IT_WORKS = [
  ['Add a client', 'and send them their private link.'],
  ['They send content.', 'It lands in your Buffer as an Idea.'],
  ['Turn it into a draft in Buffer,', 'then tap Share a draft to show it to them for approval.'],
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

// Finished clients: out of the way, but their record can still be exported, they
// can be brought back, or deleted for good.
function renderArchived(archived, reload) {
  const holder = $('archived')
  if (!archived.length) {
    holder.replaceChildren()
    return
  }
  const group = el('details', 'help archived')
  group.open = openArchived
  group.addEventListener('toggle', () => { openArchived = group.open })
  group.append(el('summary', '', `Archived (${archived.length})`))
  const list = el('ul', 'board archived-list')
  for (const client of archived) {
    const item = el('li')
    const top = el('div', 'row')
    top.append(el('strong', '', client.name), el('span', 'tip', `Archived ${when(client.archivedAt)}`))
    const actions = el('div', 'actions')
    actions.append(
      button('Export record', 'btn small', () => exportRecord(client.id, client.name)),
      button('Restore', 'link', async () => {
        try {
          const { link } = await api(`/api/clients/${client.id}/restore`, { method: 'POST' })
          showLink(client.name, link, `${client.name} is back. Their old link stays switched off, so here is a fresh one to send them:`)
          await reload()
        } catch (err) {
          showError(err.message)
        }
      }),
      el('span', 'spacer'),
      button('Delete', 'link danger', async () => {
        if (!confirm(`Delete ${client.name} for good?\n\nTheir whole record is lost and this cannot be undone. Export it first if you may need it.`)) return
        try {
          await api(`/api/clients/${client.id}`, { method: 'DELETE' })
          await reload()
        } catch (err) {
          showError(err.message)
        }
      }),
    )
    item.append(top, el('div', 'when', `${client.entries} entr${client.entries === 1 ? 'y' : 'ies'} in their record`), actions)
    list.append(item)
  }
  group.append(list)
  holder.replaceChildren(group)
}

let openArchived = false

async function loadOverview() {
  const container = $('clients')
  try {
    const { clients, archived } = await api('/api/overview')
    renderArchived(archived || [], loadOverview)
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
  nudged: 'Reminder sent',
}
const KIND_BADGE = { approved: 'approved', changes: 'changes', updated: 'waiting', shared: '', submitted: '', nudged: '' }
const COMMENT_LEAD = { approved: 'Note: ', changes: 'Changes requested: ', updated: 'What changed: ' }
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

// What the opened entry is showing, in plain words.
const DETAIL_LABEL = {
  approved: 'Exactly what was approved',
  changes: 'The post changes were requested on',
  updated: 'The updated version that was sent',
  shared: 'What was shared with them',
  submitted: 'Exactly what they sent',
}

const isHttps = (url) => typeof url === 'string' && /^https:\/\//i.test(url)

function picture(url) {
  const img = el('img')
  img.src = url
  img.alt = ''
  img.loading = 'lazy'
  img.referrerPolicy = 'no-referrer'
  return img
}

// The full content of one entry: the post, its photos and timing, and what was said.
function eventDetail(d) {
  // A reminder has no post of its own: just say how it went.
  if (d.kind === 'nudged') return [el('p', 'detail-label', 'Reminder'), el('p', 'hint', d.comment || 'A reminder was sent.')]
  const nodes = [el('p', 'detail-label', DETAIL_LABEL[d.kind] || 'Details')]
  const box = el('div', 'detail-post')

  if (d.kind === 'submitted') {
    const p = d.post
    const rows = [['Title', p.title], ['Post text', p.text], ['Extra details', p.details], ['Timing notes', p.timing], ['Preferred date', p.date]]
    const list = el('dl', 'kv')
    for (const [label, value] of rows) {
      if (!value) continue
      list.append(el('dt', '', label), el('dd', 'pre', String(value)))
    }
    box.append(list)
    const photos = (p.photos || []).filter(isHttps)
    if (photos.length) {
      const pics = el('div', 'images')
      pics.append(...photos.map(picture))
      box.append(pics)
    }
  } else {
    const p = d.post
    const where = [p.service, p.channel].filter(Boolean).join(' · ')
    if (where) box.append(el('p', 'hint', where))
    box.append(el('p', 'post-text', p.text || '(No text)'))
    const photos = (p.images || []).map((i) => i.url).filter(isHttps)
    if (photos.length) {
      const pics = el('div', 'images')
      pics.append(...photos.map(picture))
      box.append(pics)
    }
    const due = p.dueAt ? new Date(p.dueAt) : null
    box.append(el('p', 'hint', due && !Number.isNaN(due.getTime()) ? `Planned for ${when(due)}` : 'Not scheduled'))
  }
  nodes.push(box)

  if (d.comment && d.kind !== 'submitted') nodes.push(el('p', 'event-comment', `${COMMENT_LEAD[d.kind] || ''}"${d.comment}"`))
  if (!d.exact) {
    nodes.push(el('p', 'hint', 'This is an older entry. Its exact wording at that moment was not saved, so this shows the post as Handoff last had it.'))
  }
  return nodes
}

function eventCard(event, date) {
  // The whole card opens: tap it to see exactly what the entry contains.
  const card = el('details', 'event')
  const summary = el('summary')
  const top = el('div', 'event-top')
  const stamp = el('time', 'event-time', when(date))
  stamp.dateTime = date.toISOString()
  top.append(el('span', `badge ${KIND_BADGE[event.kind] || ''}`, KIND_LABEL[event.kind] || event.kind), el('strong', 'event-client', event.clientName), stamp)
  summary.append(top)
  if (event.text) {
    const flat = event.text.replace(/\s+/g, ' ').trim()
    const clipped = flat.length > 140 ? `${flat.slice(0, 139).trimEnd()}…` : flat
    summary.append(el('p', 'event-text', `${event.service ? `[${event.service}] ` : ''}${clipped}`))
  }
  if (event.comment) summary.append(el('p', 'event-comment', `${COMMENT_LEAD[event.kind] || ''}"${event.comment}"`))
  card.append(summary)

  // The full copy is fetched the first time the card is opened.
  const detail = el('div', 'event-detail')
  card.append(detail)
  let loaded = false
  card.addEventListener('toggle', async () => {
    if (!card.open || loaded) return
    loaded = true
    detail.replaceChildren(el('p', 'hint', 'Loading…'))
    try {
      detail.replaceChildren(...eventDetail(await api(`/api/history/${encodeURIComponent(event.id)}`)))
    } catch (err) {
      loaded = false
      detail.replaceChildren(el('p', 'hint', err.message))
    }
  })
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

// Installing Handoff gives it its own icon and window, and makes its notifications
// appear as "Handoff" with the app icon, instead of as a website.
let installPrompt = null
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault()
  installPrompt = event
  renderInstall()
})
window.addEventListener('appinstalled', () => {
  installPrompt = null
  renderInstall()
})

function renderInstall() {
  const text = $('install-text')
  const install = $('install-btn')
  const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
  if (installed) {
    text.textContent = '✓ Handoff is installed on this device. Its notifications appear as Handoff, with its icon.'
    install.hidden = true
    return
  }
  const apple = /iphone|ipad|ipod/i.test(navigator.userAgent)
  text.textContent = installPrompt
    ? 'Install Handoff to give it its own icon and window. Its notifications then appear as Handoff, not as a website.'
    : apple
      ? 'On an iPhone or iPad: tap Share, then Add to Home Screen. Notifications then appear as Handoff.'
      : 'In Chrome or Edge, open the browser menu and choose Install Handoff, or use the install icon in the address bar. Notifications then appear as Handoff, not as a website.'
  install.hidden = !installPrompt
}

$('install-btn').addEventListener('click', async () => {
  if (!installPrompt) return
  installPrompt.prompt()
  await installPrompt.userChoice
  installPrompt = null
  renderInstall()
})

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
  renderInstall()
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
