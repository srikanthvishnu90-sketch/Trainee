# Outlook connect: owner steps (2026-10-27, M4)

Nothing here is done by an agent: the owner registers the app, sets the secrets and runs go-live. Until
`MICROSOFT_OAUTH_CLIENT_ID` is set, "connect my outlook" says it isn't switched on and makes no link.

## 1. Register the app (Microsoft Entra admin center)
Entra admin center (entra.microsoft.com) > Identity > Applications > App registrations > New registration. Register it
with a work or school account in your own tenant (an app registered with a personal Microsoft account cannot be
publisher verified).
- **Name**: Trainee.
- **Supported account types**: "Accounts in any organizational directory (Any Microsoft Entra ID tenant - Multitenant)
  and personal Microsoft accounts (e.g. Skype, Xbox)". This is what the code's `common` endpoint expects.
- **Redirect URI**: platform **Web**, `https://<project-ref>.supabase.co/functions/v1/outlook-oauth`.
- **Certificates & secrets** > New client secret. Copy its **Value** once, straight into the secret below. Note the
  expiry (24 months at most) and put a reminder to rotate it.
- **API permissions** > Microsoft Graph > **Delegated**: `openid`, `email`, `profile`, `offline_access`, `User.Read`,
  `Mail.Read`, `Mail.Send`, `Calendars.ReadWrite`. Do not add application permissions. None of these needs admin consent
  by default; do not click "Grant admin consent" for your own tenant unless you mean to.
- **Branding & properties**: publisher domain (a domain you own and verified in the tenant), home page, terms
  (`/terms.html`) and privacy (`/privacy.html`) URLs, logo.

## 2. Secrets (names only; set with `supabase secrets set`, never in chat, the repo or a PR)
- `MICROSOFT_OAUTH_CLIENT_ID`: the Application (client) ID.
- `MICROSOFT_OAUTH_CLIENT_SECRET`: the client secret's Value.
- `OAUTH_STATE_SECRET`: already set for Gmail; the same one signs Outlook's state and derives its PKCE verifier.
- `OUTLOOK_JOBS_SECRET`: 32+ random characters; the scheduler sends it as `x-outlook-jobs-secret`.
- Optional `OUTLOOK_LINK_BASE` (defaults to `<SUPABASE_URL>/functions/v1/outlook-oauth`).

## 3. Go-live
`scripts/launch/trainee-go-live.sh` applies `20261027230000_career_outlook_connector.sql` (mark: `career_outlook_sends`,
`career_outlook_claim`, the disconnect trigger) and deploys `outlook-oauth` with `--no-verify-jwt`. Then schedule the two
batch runs (pg_cron or any scheduler), e.g. every 5 minutes:
`POST <SUPABASE_URL>/functions/v1/outlook-oauth` with `content-type: application/json`, header `x-outlook-jobs-secret`,
body `{"kind":"refresh","batch":200}` and `{"kind":"sync","batch":200}`. More schedulers or workers can run at once.

## 4. Work and school tenants (admin consent)
- Many organizations turn off user consent, or allow it only for verified publishers and low-risk permissions. Their
  people then see "Need admin approval". `Mail.Send` and `Mail.Read` are commonly held for admin review.
- An admin of that tenant can grant consent for everyone at
  `https://login.microsoftonline.com/<their-tenant-id>/adminconsent?client_id=<client id>&redirect_uri=<redirect URI>`,
  or approve the request in their admin consent workflow. Trainee never asks a person for an admin's sign-in.
- If a tenant's Conditional Access or a password change revokes the grant, Trainee marks the person `needs_reconnect`
  and tells them to text "connect my outlook".

## 5. Publisher verification (recommended before a wide launch)
- Needs a Microsoft AI Cloud Partner Program account (the partner global account) that completed verification, whose
  verification email domain matches the app's publisher domain (or a DNS-verified domain in the tenant), and a person in
  the tenant with Application Administrator or Cloud Application Administrator, signed in with MFA. Then App
  registration > Branding & properties > "Add Partner One ID to verify publisher".
- Without it, consent shows "unverified", and tenants with risk-based step-up consent block user consent for multitenant
  apps registered after November 2020 that ask for more than sign-in and profile (Trainee asks for mail and calendar).

## 6. Live check (after go-live, the owner's own account)
"connect my outlook" on Telegram, open the link in the phone's browser, sign in, then:
```sql
select provider, email, scopes, vault_name from public.user_oauth_connections where user_id = '<uid>' and provider = 'microsoft';
select name from vault.secrets where name = 'oauth_microsoft_<uid>';
select channel, purpose, opened_at, finished_at, outcome from public.career_outlook_links where user_id = '<uid>' order by created_at desc limit 3;
select token_expires_at, delta_link is not null, synced_at, needs_reconnect_at, retry_after from public.career_outlook_state where user_id = '<uid>';
```
Then "disconnect outlook": the first two return nothing, and `career_outlook_state` / `career_outlook_messages` have no
rows for you. Remove Trainee at account.live.com/consent/Manage or myapps.microsoft.com to finish.

## Sources
- Authorization code flow with PKCE, `common`, offline_access, refresh token replacement:
  https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow
- No per-app refresh-token revocation endpoint: https://learn.microsoft.com/en-us/answers/questions/993951/revoke-oauth-refresh-token-api
- sendMail (Mail.Send, 202 Accepted, personal accounts supported): https://learn.microsoft.com/en-us/graph/api/user-sendmail
- Delta query for messages (per folder, nextLink/deltaLink, $filter receivedDateTime ge): https://learn.microsoft.com/en-us/graph/delta-query-messages,
  https://learn.microsoft.com/en-us/graph/api/message-delta
- getSchedule (personal accounts not supported): https://learn.microsoft.com/en-us/graph/api/calendar-getschedule
- calendarView (personal accounts supported): https://learn.microsoft.com/en-us/graph/api/user-list-calendarview
- Online meetings on events (allowedOnlineMeetingProviders, teamsForBusiness, joinUrl): https://learn.microsoft.com/en-us/graph/outlook-calendar-online-meetings
- Create event (transactionId, Calendars.ReadWrite for personal accounts): https://learn.microsoft.com/en-us/graph/api/calendar-post-events
- Throttling (429, Retry-After): https://learn.microsoft.com/graph/throttling
- Publisher verification: https://learn.microsoft.com/entra/identity-platform/publisher-verification-overview
- Users removing app permissions: https://support.microsoft.com/en-US/accounts-billing/work-school/edit-or-revoke-application-permissions-in-the-my-apps-portal
