# Handoff

**Content in. Approvals out. All through Buffer.**

Handoff is a small web app for anyone who publishes through Buffer on someone else's behalf, or needs someone's sign-off before a post goes out. You sign in with Buffer and create a private link for each client (for a creator, that might be a brand or sponsor). Through that link, with no login, the client can:

1. **Send content**: text, photos, details and timing. It arrives in the manager's Buffer as an **Idea tagged with the client's name**.
2. **Review posts**: when the manager turns that Idea into a draft in Buffer, they tap **Share a draft** to show it to the client. The post is written in the manager's own words, informed by what the client sent, and a draft is not always ready for client eyes, so nothing is ever shared without the manager's say-so. The client sees how it will look, then **approves it or requests changes**. Their answer is saved as a **Note on the post in Buffer**.

The manager gets one simple screen showing, per client, what is waiting, approved, or needs changes. She also gets a **push notification** when a client approves, asks for changes, or sends something new. Clients can turn on notifications too, so they hear when a post is ready or a revised version is waiting, with no chat app or email involved. After revising a post in Buffer, the manager clicks **Send updated version** to put the new version in front of the client.

Live: https://handoff-nine-lemon.vercel.app

## Who it's for

Handoff suits anyone who works in Buffer and has to get content from, or approval of, someone who isn't in Buffer.

| Who | How they use it | Why Handoff fits |
| --- | --- | --- |
| **Freelance social media managers** | One private link per client. Clients send ideas and photos, and approve drafts. | No client portal to build, and no emails to chase. Each client's card shows what is waiting. |
| **Small agencies and studios** | The same, across a whole client list, with a record of every approval. | History keeps the exact version each client approved, with the date. That settles "I never said yes to that." |
| **Creators working with brands** | A brand or sponsor sends a brief and assets through the link, then approves the post before it goes live. | The brand needs no Buffer account and no login, which makes approval faster. |
| **Freelance writers, designers and video editors** | They prepare posts for a client and send them back for a yes or a list of changes. | The client answers on one page, and the answer lands as a Note on the post. |
| **Virtual assistants and part-time marketers** | They post for a busy founder, who approves from a link on their phone. | The founder taps Approve in seconds. No app to install, no account to create. |

What they all share:

- **Nothing to sign up for.** The person on the other side only needs a link.
- **It stays in Buffer.** Content arrives as a tagged Idea, and feedback arrives as a Note on the post.
- **A clear record.** Every step has a date and time, and the approved version is kept exactly as it was.
- **Light by design.** It doesn't replace Buffer. It covers the part that used to happen in email and chat.

## How it uses Buffer

| Feature | Buffer API |
| --- | --- |
| Sign in | OAuth 2.0 authorization code flow with PKCE (App Client), with refresh-token rotation |
| Client submission | `createIdea` (with tags and media), `createTag`, `tagsV2` |
| Reading drafts | `posts` filtered by `draft` / `needs_approval` |
| Client feedback | `createCollaborationNote` on the post |

The scopes requested are `account:read posts:read posts:write ideas:read ideas:write notes:read notes:write offline_access`.

## Design decisions

- **The client's link is the only credential.** Links are 128 bits of randomness (22 characters). Only a SHA-256 fingerprint is stored, so a leaked database does not leak working links. A link can be replaced at any time, which kills the old one. A client's page only ever shows that client's posts.
- **The manager's Buffer connection lives on the server, encrypted** (AES-256-GCM), because clients who are not signed in need the app to act for the manager. Buffer refresh tokens are single-use, so a database lock lets exactly one request renew them at a time.
- **Opening a client page costs no Buffer API calls.** A copy of each shared post is stored when it is shared, and new drafts are looked up at most once a minute. App Clients have a small shared rate limit, so this matters.
- **Sharing is the manager's choice, and Handoff never guesses.** The client's form tells the manager what the client wants covered; the manager writes the post in her own words. A draft reaches a client only when she taps Share a draft. To make that quick, she chooses once which Buffer channels she posts to for each client; **Share a draft** then shows that client's channel drafts first, with everything else folded under "Other drafts" and a search box, so no draft is ever out of reach. Nothing is matched by reading a post's words.
- **No refreshing, anywhere.** Pages ask a tiny "has anything changed?" question every few seconds and redraw only when the answer is yes. When a post the client asked changes on is edited in Buffer, Handoff notices and offers **Send updated version** as one tap.
- **Finishing with a client.** Clients can be archived (their link stops working, their record stays) and the record exported as a spreadsheet for bookkeeping. The manager can also see when a client last opened their link, and send a reminder.
- **Buffer's Free plan allows 3 tags.** Clients get their own tag while slots remain. Every Idea also starts with the client's name in its title, so nothing is lost after the tags run out.
- **Feedback is stored twice.** It goes to Buffer as a Note and is also kept in Handoff's database, so it is never lost if Buffer is unavailable (Notes are experimental).
- **Post metrics are not used**: they are not available to App Clients.

## Stack

Node.js 22+ and Express (from Buffer's `app-client-starter-app`), Neon Postgres, Cloudinary for photos, Vercel for hosting, and the Web Push API for notifications. The front end is plain HTML and JavaScript with no build step.

## Run it locally

You need Node.js 22+, a Buffer account, a free Neon database and a free Cloudinary account.

1. Create an App Client at <https://publish.buffer.com/settings/api> (private client). Add `https://localhost:3000/callback` as a redirect URI.
2. `npm install`
3. Copy `.env.example` to `.env` and fill it in: Buffer client ID and secret, `DATABASE_URL`, and the three `CLOUDINARY_*` values.
4. `npm start`, then open <https://localhost:3000> and accept the self-signed certificate once. Buffer requires https, so the dev server makes its own certificate.

`npm test` runs the tests. Tests that need the database skip themselves if `DATABASE_URL` is not set.

## Deploy to Vercel

Import the repository with the framework preset **Other** and set the same environment variables, plus a `SESSION_SECRET` (at least 32 characters; it also derives the token encryption key). Add `https://YOUR-DOMAIN/callback` as a second redirect URI in your Buffer App Client.

## Project structure

| Path | What it holds |
| --- | --- |
| `lib/app.js` | Express routes: manager side, and the no-login client side |
| `lib/buffer.js` | OAuth, GraphQL requests, rate-limit handling, token renewal |
| `lib/db.js` | Database tables and queries, private-link tokens |
| `lib/ideas.js` | Turns a client submission into a tagged Buffer Idea |
| `lib/approvals.js` | Reads drafts, matches them to clients, writes decisions as Notes |
| `lib/push.js` | Push notifications |
| `lib/crypto.js`, `lib/cloudinary.js` | Token encryption; signed photo uploads |
| `public/` | The dashboard (`index.html`), the client page (`client.html`), service worker |
| `test/` | Tests for the security-sensitive parts |

## Credits

Built from Buffer's [app-client-starter-app](https://github.com/bufferapp/buffer-sample-apps/tree/main/samples/app-client-starter-app) (MIT license). Handoff is an independent project and not an official Buffer product.
