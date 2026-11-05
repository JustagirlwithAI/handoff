import { graphql } from './buffer.js'
import { rememberClientBuffer } from './db.js'

// Buffer's Free plan allows 3 tags in total. Clients get their own tag until
// those run out. After that the Idea still carries the client's name at the
// start of its title, so nothing is ever lost or unidentifiable.
const FREE_PLAN_TAG_LIMIT = 3
const TAG_COLORS = ['#418829', '#2a6fdb', '#d9822b', '#8e44ad', '#c0392b', '#16a085']

const ORGS_QUERY = `query { account { organizations { id } } }`

const TAGS_QUERY = `
  query Tags($organizationId: OrganizationId!) {
    tagsV2(input: { organizationId: $organizationId }) {
      totalCount
      edges { node { id name color } }
    }
  }
`

const CREATE_TAG = `
  mutation CreateTag($input: CreateTagInput!) {
    createTag(input: $input) {
      __typename
      ... on TagActionSuccess { tag { id name color } }
      ... on MutationError { message }
    }
  }
`

// createIdea answers with a union: the new Idea, or a typed error.
const CREATE_IDEA = `
  mutation CreateIdea($input: CreateIdeaInput!) {
    createIdea(input: $input) {
      __typename
      ... on Idea { id }
      ... on IdeaResponse { idea { id } }
      ... on MutationError { message }
    }
  }
`

async function organizationFor(ctx, client) {
  if (client.organization_id) return client.organization_id
  const { account } = await graphql(ctx, ORGS_QUERY)
  const organizationId = account.organizations[0]?.id
  if (!organizationId) throw new Error('This Buffer account has no organization')
  await rememberClientBuffer(client.id, { organizationId })
  return organizationId
}

// Finds this client's tag, or makes one if a free slot remains. Never throws:
// a tag is a nice-to-have, and a missing one must not lose a client's content.
async function tagFor(ctx, client, organizationId) {
  try {
    const { tagsV2 } = await graphql(ctx, TAGS_QUERY, { organizationId })
    const tags = tagsV2.edges.map((e) => e.node)
    const existing = tags.find((t) => t.id === client.tag_id) || tags.find((t) => t.name === client.name)
    if (existing) {
      if (existing.id !== client.tag_id) await rememberClientBuffer(client.id, { tagId: existing.id })
      return existing
    }
    if (tagsV2.totalCount >= FREE_PLAN_TAG_LIMIT) return null

    const color = TAG_COLORS[tags.length % TAG_COLORS.length]
    const { createTag } = await graphql(ctx, CREATE_TAG, {
      input: { organizationId, tag: { name: client.name.slice(0, 40), color } },
    })
    if (!createTag?.tag) return null
    await rememberClientBuffer(client.id, { tagId: createTag.tag.id })
    return createTag.tag
  } catch (err) {
    console.warn(JSON.stringify({ event: 'tag_skipped', message: err.message }))
    return null
  }
}

// Ideas hold a title, text, media, one date and tags, so the extra details
// are written into the text below the caption.
export function buildIdeaContent(client, submission, tag) {
  const parts = [submission.text.trim()]
  const extras = []
  if (submission.details) extras.push(`Details: ${submission.details.trim()}`)
  if (submission.timing) extras.push(`Preferred timing: ${submission.timing.trim()}`)
  if (extras.length) parts.push(`---\n${extras.join('\n')}`)

  const content = {
    title: `${client.name}: ${submission.title.trim()}`.slice(0, 120),
    text: parts.join('\n\n'),
  }
  if (submission.photos.length) {
    content.media = submission.photos.map((url) => ({ url, type: 'image' }))
  }
  if (submission.date) content.date = `${submission.date}T09:00:00.000Z`
  if (tag) content.tags = [{ id: tag.id, name: tag.name, color: tag.color }]
  return content
}

// Returns { ideaId, tagged }. Throws if Buffer refuses the Idea.
export async function createIdeaForClient(ctx, client, submission) {
  const organizationId = await organizationFor(ctx, client)
  const tag = await tagFor(ctx, client, organizationId)
  const result = (await graphql(ctx, CREATE_IDEA, {
    input: { organizationId, content: buildIdeaContent(client, submission, tag) },
  })).createIdea

  const ideaId = result?.id || result?.idea?.id
  if (!ideaId) throw new Error(result?.message || `Buffer did not create the idea (${result?.__typename})`)
  return { ideaId, tagged: Boolean(tag) }
}
