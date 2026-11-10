import { CREATE_NOTE, graphql } from './buffer.js'
import { notifyClient, reviewMessage } from './push.js'
import {
  claimSync, createShareIfAbsent, getOwnerOrganization, listMatchData, listShareIndex, setOwnerOrganization, updateShareSnapshot,
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
    id status text channelService dueAt
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
    id status text channelService dueAt
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
    tags: (e.node.tags || []).map((t) => t.name),
    ...snapshotFromPost(e.node),
  }))
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

/* ------------------------------------------------- automatic matching */
// When the manager turns a client's Idea into a draft in Buffer, Handoff
// recognises it and shows it to that client, with no extra clicking:
//   1. by tag: Buffer carries the client's tag onto the post, or
//   2. by text: the post still starts with what the client wrote.
// If neither is certain (or two clients would match), it does nothing and the
// manager can share the draft by hand.
export function matchClient(draft, clients, bodies) {
  const tagNames = new Set((draft.tags || []).map((name) => String(name).toLowerCase()))
  const byTag = clients.filter((c) => tagNames.has(c.name.slice(0, 40).toLowerCase()))
  if (byTag.length === 1) return byTag[0]

  // No tag, or several clients share the tag's name: let what the client wrote
  // decide, looking only among the tag's candidates when there are any.
  const candidates = new Set((byTag.length ? byTag : clients).map((c) => c.id))
  const text = String(draft.text || '').trim()
  const ids = new Set(
    bodies
      .filter((b) => candidates.has(b.client_id) && b.body.trim() && text.startsWith(b.body.trim()))
      .map((b) => b.client_id),
  )
  if (ids.size !== 1) return null
  return clients.find((c) => c.id === [...ids][0]) || null
}

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

// Looks for new drafts and shares matching ones. Safe to call often (it only
// reaches Buffer once a minute) and it never throws: a hiccup here must not
// break the page that asked.
export async function syncAutoShares(ownerId) {
  try {
    if (!(await claimSync(ownerId))) return 0
    const ctx = { ownerId }
    const organizationId = await ownerOrganization(ctx, ownerId)
    const [posts, { clients, bodies }, index] = await Promise.all([
      listActivePosts(ctx, organizationId), listMatchData(ownerId), listShareIndex(ownerId),
    ])

    // 1. Keep what clients already see in step with Buffer (for instance, a
    //    date the manager just scheduled).
    for (const update of snapshotUpdates(posts, index)) await updateShareSnapshot(update.id, update.snapshot)

    // 2. Share posts that belong to a client and have not been shared yet.
    let added = 0
    for (const post of posts) {
      const client = matchClient(post, clients, bodies)
      if (client && (await createShareIfAbsent(client.id, post.id, snapshotOnly(post)))) {
        added++
        await notifyClient(client.id, reviewMessage(false, post.text, post.images?.[0]?.url)) // tell the client it is ready
      }
    }
    return added
  } catch (err) {
    console.warn(JSON.stringify({ event: 'auto_share_failed', message: err.message }))
    return 0
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
