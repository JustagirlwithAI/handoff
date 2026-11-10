import { CHANNELS_QUERY, CREATE_NOTE, graphql } from './buffer.js'
import {
  claimSync, clearEdited, getOwnerOrganization, listShareIndex, markEdited, setOwnerOrganization, updateShareSnapshot,
} from './db.js'

// Posts a manager can share for approval: drafts, and posts already waiting for
// approval inside Buffer.
const DRAFTS_QUERY = `
  query Drafts($organizationId: OrganizationId!, $statuses: [PostStatus!], $first: Int) {
    posts(first: $first, input: {
      organizationId: $organizationId,
      filter: { status: $statuses },
      sort: [{ field: createdAt, direction: desc }]
    }) {
      edges { node { ...PostFields } }
    }
  }
  fragment PostFields on Post {
    id status text channelService channelId createdAt dueAt
    channel { name displayName }
    assets { type source thumbnail }
    tags { name }
  }
`

const POST_QUERY = `
  query OnePost($id: PostId!) {
    post(input: { id: $id }) { ...PostFields }
  }
  fragment PostFields on Post {
    id status text channelService channelId createdAt dueAt
    channel { name displayName }
    assets { type source thumbnail }
    tags { name }
  }
`

const isHttps = (url) => typeof url === 'string' && /^https:\/\//i.test(url)

// The copy of a post that the client sees. Kept small and plain on purpose.
export function snapshotFromPost(post) {
  return {
    text: String(post.text ?? '').slice(0, 5000),
    service: post.channelService,
    channel: post.channel?.displayName || post.channel?.name || '',
    dueAt: post.dueAt || null,
    images: (post.assets || [])
      .map((a) => ({ type: a.type, url: a.type === 'image' ? a.source : a.thumbnail }))
      .filter((a) => isHttps(a.url))
      .slice(0, 6),
  }
}

export function listDrafts(ctx, organizationId) {
  return listPosts(ctx, organizationId, ['draft', 'needs_approval'], 50)
}

// Everything a client might be looking at: drafts, and posts the manager has
// already scheduled (a scheduled post is still worth the client's eyes).
export function listActivePosts(ctx, organizationId) {
  return listPosts(ctx, organizationId, ['draft', 'needs_approval', 'scheduled'], 100)
}

async function listPosts(ctx, organizationId, statuses, first) {
  const data = await graphql(ctx, DRAFTS_QUERY, { organizationId, statuses, first })
  return (data.posts.edges || []).map((e) => ({
    id: e.node.id,
    status: e.node.status,
    channelId: e.node.channelId,   // which Buffer channel it is going to (ties a draft to a client)
    createdAt: e.node.createdAt,
    tags: (e.node.tags || []).map((t) => t.name),
    ...snapshotFromPost(e.node),
  }))
}

// The Buffer channels the manager can choose from for a client (connected ones only).
export async function listChannels(ctx, organizationId) {
  const { channels } = await graphql(ctx, CHANNELS_QUERY, { organizationId })
  return channels
    .filter((c) => !c.isDisconnected)
    .map((c) => ({ id: c.id, name: c.displayName || c.name, service: c.service }))
}

// Fetches one post and checks it can still be shared (it must be a draft or
// waiting for approval, never something already published).
export async function snapshotForSharing(ctx, postId, { allowScheduled = false } = {}) {
  const { post } = await graphql(ctx, POST_QUERY, { id: postId })
  const allowed = allowScheduled ? ['draft', 'needs_approval', 'scheduled'] : ['draft', 'needs_approval']
  if (!allowed.includes(post.status)) {
    const error = new Error(allowScheduled
      ? 'This post has already been sent, so it can no longer be updated for the client.'
      : 'Only drafts can be shared for approval.')
    error.status = 400
    throw error
  }
  return snapshotFromPost(post)
}

// Writes the client's decision onto the post as a Buffer Note. Returns
// { saved, error }; never throws, because the decision is already stored in our
// own database and must not be lost if Buffer is unhappy.
export async function saveDecisionNote(ctx, postId, clientName, decision, comment) {
  const text = decision === 'approved'
    ? `✅ Approved by ${clientName}${comment ? `: ${comment}` : ''}`
    : `✏️ ${clientName} requested changes: ${comment}`
  try {
    const note = (await graphql(ctx, CREATE_NOTE, {
      input: { subject: { postId }, text: text.slice(0, 2000), annotations: [] },
    })).createCollaborationNote
    if (note?.__typename === 'CreateCollaborationNoteSuccess') return { saved: true, error: null }
    return { saved: false, error: `${note?.__typename}: ${note?.message || ''}`.slice(0, 300) }
  } catch (err) {
    return { saved: false, error: String(err.message).slice(0, 300) }
  }
}

// Handoff never decides which draft belongs to a client by reading its words: the
// manager writes each post in her own words, informed by what the client sent. A
// draft reaches a client only when the manager shares it. The one link Handoff
// uses to help her find the right draft is the Buffer channel (see client channels).

export function snapshotOnly(draft) {
  const { text, service, channel, dueAt, images } = draft
  return { text, service, channel, dueAt, images }
}

// The organization drafts live in. Remembered after the first lookup.
export async function ownerOrganization(ctx, ownerId) {
  const known = await getOwnerOrganization(ownerId)
  if (known) return known
  const { account } = await graphql(ctx, 'query { account { organizations { id } } }')
  const organizationId = account.organizations[0]?.id
  if (!organizationId) throw new Error('This Buffer account has no organization')
  await setOwnerOrganization(ownerId, organizationId)
  return organizationId
}

// Has the post's actual content (words or photos) changed? Timing and channel do
// not count: this is about whether there is a new version worth sending.
export function contentDiffers(a, b) {
  const urls = (snapshot) => JSON.stringify((snapshot?.images || []).map((i) => i.url))
  return String(a?.text ?? '') !== String(b?.text ?? '') || urls(a) !== urls(b)
}

// For posts where the client asked for changes: which have been edited in Buffer
// since (and which are back to the version the client saw).
export function editedState(posts, index) {
  const byId = new Map(posts.map((p) => [p.id, p]))
  const edited = []
  const unedited = []
  for (const share of index) {
    if (share.status !== 'changes') continue
    const post = byId.get(share.post_id)
    if (!post) continue
    ;(contentDiffers(snapshotOnly(post), share.snapshot) ? edited : unedited).push(share.id)
  }
  return { edited, unedited }
}

const SNAPSHOT_KEYS = ['text', 'service', 'channel', 'dueAt']
export function sameSnapshot(a, b) {
  return SNAPSHOT_KEYS.every((k) => (a?.[k] ?? null) === (b?.[k] ?? null)) &&
    JSON.stringify(a?.images ?? []) === JSON.stringify(b?.images ?? [])
}

// Works out which client copies of a post are out of date.
//  - Still waiting for the client: bring the whole copy up to date.
//  - Already answered: update only the planned date and leave the wording alone,
//    so the words under a client's approval never change behind their back. (To
//    put a revised text in front of them, the manager uses "Send updated version".)
export function snapshotUpdates(posts, index) {
  const byId = new Map(posts.map((p) => [p.id, p]))
  const updates = []
  for (const share of index) {
    const post = byId.get(share.post_id)
    if (!post) continue
    const fresh = snapshotOnly(post)
    const next = share.status === 'waiting' ? fresh : { ...share.snapshot, dueAt: fresh.dueAt }
    if (!sameSnapshot(next, share.snapshot)) updates.push({ id: share.id, snapshot: next })
  }
  return updates
}

// Keeps what clients see in step with Buffer. It never shares anything new: it only
// brings posts already shared with a client up to date. Safe to call often (it only
// reaches Buffer once a minute), and it never throws: a hiccup here must not break
// the page that asked.
export async function syncShares(ownerId) {
  try {
    if (!(await claimSync(ownerId))) return
    const ctx = { ownerId }
    const organizationId = await ownerOrganization(ctx, ownerId)
    const [posts, index] = await Promise.all([listActivePosts(ctx, organizationId), listShareIndex(ownerId)])

    // 1. Keep what clients already see in step with Buffer (for instance, a
    //    date the manager just scheduled).
    for (const update of snapshotUpdates(posts, index)) await updateShareSnapshot(update.id, update.snapshot)

    // 2. Notice when a post the client asked changes on has since been edited in
    //    Buffer, so "Send updated version" can be offered as the obvious next step.
    const { edited, unedited } = editedState(posts, index)
    await Promise.all([markEdited(edited), clearEdited(unedited)])
  } catch (err) {
    console.warn(JSON.stringify({ event: 'sync_failed', message: err.message }))
  }
}

// Leaves a trace in Buffer that an updated version went back to the client.
// Best effort, like the decision notes: it must never block the update itself.
export async function saveUpdateNote(ctx, postId, note) {
  try {
    const text = `🔁 Updated version sent back to the client${note ? `: ${note}` : ''}`
    const result = (await graphql(ctx, CREATE_NOTE, {
      input: { subject: { postId }, text: text.slice(0, 2000), annotations: [] },
    })).createCollaborationNote
    return result?.__typename === 'CreateCollaborationNoteSuccess'
  } catch {
    return false
  }
}
