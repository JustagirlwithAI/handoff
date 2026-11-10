# Handoff

**Client content in. Client approvals out. All through Buffer.**

Handoff is a small web app for social media managers who work with clients. The manager signs in with Buffer and creates a private link for each client. Through that link, with no login, the client can:

1. **Send content**: text, photos, details and timing. It arrives in the manager's Buffer as an **Idea tagged with the client's name**.
2. **Review posts**: when the manager turns that Idea into a draft in Buffer, they tap **Share a draft** to show it to the client (a draft is not always ready for client eyes, so nothing is shared without the manager's say-so; an optional automatic mode exists). The client sees how it will look, then **approves it or requests changes**. Their answer is saved as a **Note on the post in Buffer**.

The manager gets one simple screen showing, per client, what is waiting, approved, or needs changes. She also gets a **push notification** when a client approves, asks for changes, or sends something new. Clients can turn on notifications too, so they hear when a post is ready or a revised version is waiting, with no chat app or email involved. After revising a post in Buffer, the manager clicks **Send updated version** to put the new version in front of the client.

Live: https://handoff-nine-lemon.vercel.app

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
- **Sharing is the manager's choice.** A draft is not always ready for a client to see, so by default it reaches a client only when the manager taps Share a draft. An optional automatic mode (Account, Preferences) matches drafts to clients itself: Buffer does not record which Idea a post came from, so it matches by the client's tag, then by what the client wrote, and does nothing when it is not certain.
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
