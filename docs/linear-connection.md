# Linear connection

Open Squadron under BB's installed-plugin settings. The personal API key and
OAuth client secret use BB's native secret fields. Saving a personal API key,
then pressing **Check connection**, shows its workspace and account. Writes
use that person's name.

For the app connection, the owner creates a Linear OAuth application named
**Squadron** in Linear's API settings. Register the exact callback URL shown
under **OAuth app setup**. Its path is
`/api/v1/plugins/squadron/http/linear/callback`; its origin comes from BB's
configured public app URL, or BB's loopback URL when no public URL is configured.
For the shared BB at `https://sizemore.getbb.app`, the callback is
`https://sizemore.getbb.app/api/v1/plugins/squadron/http/linear/callback`.
The callback must be reachable from the browser used to approve the app.

The owner enters the application's client ID and client secret in Squadron's
settings, then presses **Connect Linear**. Authorization requests
`response_type=code`, `actor=app`, `scope=read,write` and S256 PKCE. The state
expires after ten minutes and is accepted only once. A new Connect request
replaces the previous pending request. Webhooks and the client-credentials
grant are unused.

The app's access token, refresh token and expiry are stored together in the
`linearCredentials` secret setting. The server refreshes within a minute of
expiry, saves the rotated token pair together, and shares one renewal among
concurrent requests. The settings page receives only workspace and actor
identity. **Disconnect** clears the personal key and app token pair and
invalidates pending callbacks. OAuth application configuration remains saved.

## Server interface

`registerLinearAuth(bb, options?)` in `lib/linear-auth.ts` registers settings,
the OAuth callback and connection RPCs, and returns a `LinearAuth` service.

- `getConnection(): Promise<LinearConnectionState>` verifies identity and
  returns `status`, `mode`, `workspace`, `actor` and a safe message. Doctor
  can read its `status` without knowing credentials.
- `graphql<T>(query, variables?, signal?): Promise<T>` returns GraphQL `data`.
  Sync and the Helper's write outbox consume this server interface. No
  frontend GraphQL RPC is registered. Mutations belong to the Helper outbox.

Every request reads current credentials. Personal keys use the raw
Authorization header; app tokens use Bearer. The adapter observes request and
complexity budget reset headers and rate-limit responses. It returns
`LinearRequestError` with a stable `code` and optional `retryAfterMs`, never
provider response text or request credentials. It does not retry requests;
the outbox decides when a write may be retried. Requests time out after 20
seconds and abort when the plugin unloads. An individual GraphQL caller can
also supply an abort signal.

## Validation boundary

The fixture tests use saved API response shapes with invented identities
and fake secrets. No live workspace, OAuth app setup, credential, or mutation
is needed. Live installation and browser callback reachability require the
owner's OAuth setup and remain unproven until it is exercised.

Sources: [Linear OAuth](https://linear.app/developers/oauth-2-0-authentication),
[app actors](https://linear.app/developers/oauth-actor-authorization), and
[rate limits](https://linear.app/developers/rate-limiting).
