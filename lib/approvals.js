import { CREATE_NOTE, graphql } from './buffer.js'

// Posts a manager can share for approval: drafts, and posts already waiting for
// approval inside Buffer.
const DRAFTS_QUERY = `
  query Drafts($organizationId: OrganizationId!) {
    posts(first: 50, input: {
      organizationId: $organizationId,
      filter: { status: [draft, needs_approval] },
      sort: [{ field: createdAt, direction: desc }]
    }) {
      edges { node { ...PostFields } }
    }
  }
  fragment PostFields on Post {
    id status text channelService dueAt
    channel { name displayName }
    assets { type source thumbnail }
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

export async function listDrafts(ctx, organizationId) {
  const data = await graphql(ctx, DRAFTS_QUERY, { organizationId })
  return (data.posts.edges || []).map((e) => ({ id: e.node.id, status: e.node.status, ...snapshotFromPost(e.node) }))
}

// Fetches one post and checks it can still be shared (it must be a draft or
// waiting for approval, never something already published).
export async function snapshotForSharing(ctx, postId) {
  const { post } = await graphql(ctx, POST_QUERY, { id: postId })
  if (!['draft', 'needs_approval'].includes(post.status)) {
    const error = new Error('Only drafts can be shared for approval.')
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
