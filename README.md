# IMAP MCP Server

A powerful Model Context Protocol (MCP) server that provides seamless IMAP email integration with secure account management and connection pooling.

## Features

- 🔐 **Secure Account Management**: Encrypted credential storage with AES-256 encryption
- 🚀 **Connection Pooling**: Efficient IMAP connection management
- 📧 **Comprehensive Email Operations**: Search, read, move, mark, delete, and bulk delete emails
- ✉️ **Email Sending**: Send, reply, and forward emails via SMTP
- 📁 **Folder Management**: List folders, check status, get unread counts
- 🔄 **Multiple Account Support**: Manage multiple IMAP accounts simultaneously
- 🛡️ **Type-Safe**: Built with TypeScript for reliability
- 🖥️ **CLI Setup**: Account configuration with provider presets and hidden password prompts
- 📱 **15+ Email Providers**: Pre-configured settings for Gmail, Outlook, Yahoo, and more
- 🔗 **Auto SMTP Configuration**: Automatic SMTP settings based on IMAP provider
- 🐳 **Docker Deployment**: Authenticated Streamable HTTP, shared persistence and a localhost reverse-proxy port

## Installation

> **Requires Node.js 22.12 or newer.** Node 18 and 20 have both reached
> end-of-life, and several of this package's dependencies no longer support
> them. Check yours with `node --version`.

### Run via npx (No Installation Required)

Once published to npm, you can run the server directly without cloning or building anything — `npx` downloads the prebuilt package and runs it:

```bash
npx -y imap-mcp-server
```

This is the easiest way to use the server in an MCP client (see [Configuration](#configuration) for ready-to-paste `npx` configs).

### From this repository

```bash
npm ci
# Configure accounts and persistence before building the image:
npm run setup -- init
npm run setup -- add
# Set IMAP_MCP_OAUTH_ISSUER, IMAP_MCP_OAUTH_RESOURCE_URL and your public hostname in .env first.
docker compose up --build -d
```

Requires Docker with Compose **2.30 or newer**. The CLI generates `.env` with
absolute host paths and your numeric UID/GID. It creates `.imap-mcp/accounts.json`,
`.imap-mcp/.key` and `downloads/` before the build.
Passwords are encrypted through the same `AccountManager` used by MCP tools.
The image build never reads this configuration; `.dockerignore` allows only
source and package/build files into the context.

For local stdio instead, run `npm run build` and `npm start`. A published npm
package can still be run with `npx -y imap-mcp-server`; the new HTTP/CLI features
require a release containing these changes.

## Account Setup

The web wizard and installer scripts have been replaced by a local TypeScript
CLI, available as `npm run setup -- <command>` before a build and `imap-setup`
in the built package. No browser or unauthenticated setup HTTP API is started.
Without `.env` or an explicit path, account commands use `~/.imap-mcp`. Docker
initialization defaults to `./.imap-mcp`; subsequent commands read that path
from the generated `.env`. Always run from the repository directory or provide
`--config-dir /absolute/path/to/config` when editing a Docker deployment.

```bash
npm run setup -- init                  # Docker files, OAuth config, UID/GID and .env
npm run setup -- providers             # Provider IDs and connection presets
npm run setup -- add                   # Interactive; passwords are hidden
npm run setup -- list                  # No passwords in the output
npm run setup -- edit ACCOUNT_ID       # Blank password retains the existing one
npm run setup -- test ACCOUNT_ID       # Explicit IMAP connection/folder test
npm run setup -- remove ACCOUNT_ID     # Removes only that account configuration
npm run setup -- oauth-check           # Validate env and Keycloak discovery
npm run setup -- claude-config         # Optional local stdio client configuration
```

`init` retains existing accounts, encryption keys and `.env`. It does not create
a static bearer secret. Configure OAuth before starting HTTP; blank URLs fail closed.
You can supply `init --oauth-issuer https://auth.example.com/realms/mail-mcp
--oauth-resource-url https://mail-mcp.example.com/mcp --oauth-scopes "imap:access"`
on one command line to generate these settings. Existing `.env` files are preserved,
so flags do not silently migrate an existing deployment.
If it preserves an existing `.env`, verify its paths and UID/GID match the
prepared directories. `init --download-dir /path --compose-env-file /path/.env`
customizes deployment output; use Compose `--env-file` for a non-default file.
On Windows, supply non-root `--uid` and `--gid` explicitly. On Linux, use the
owner of the bind-mounted files; a root-owned `0600` store cannot be read by a
non-root container. Do not solve that by making credential files world-readable.

The interactive flow supports provider detection, custom hosts/ports, TLS and
STARTTLS, separate IMAP login and From address, SMTP credentials, Sent behavior,
Sent-folder override, default BCC and all four environment-managed credentials.
Connection tests are explicit and are never run during `init`, `add` or `edit`.
The CLI supports the old wizard's JSON field names for scripted setup:

```json
{
  "name": "Work Gmail",
  "email": "me@gmail.com",
  "imapPasswordFromEnv": true,
  "saveToSent": true,
  "sentFolder": "[Gmail]/Sent Mail",
  "defaultBcc": "archive@example.com"
}
```

Use `npm run setup -- add --input /path/to/account.json` or
`npm run setup -- add --input -` with JSON on stdin. For edits, send only fields
to change: `edit ACCOUNT_ID --input -`. Provider defaults include SMTP settings;
`"smtp": null` explicitly disables stored SMTP settings (the existing mail
service can still infer SMTP when sending). Custom settings accept
`host`, `port`, `tls`, `allowStartTLS`, `imapUsername`, `password`, and an optional
`smtp` object with `host`, `port`, `secure`, `user`, `password`, `authMethod`, `tls`.
`sentFolder: ""` and `defaultBcc: ""` clear those overrides. Omitted credentials
are retained on edits; empty credentials can mark an environment-managed field.
Do not put secrets in command arguments. Store any input JSON containing secrets
only in your private configuration directory and remove it when finished.

Existing `~/.imap-mcp` accounts work unchanged. To reuse them for Docker:

```bash
npm run setup -- --config-dir "$HOME/.imap-mcp" init
npm run setup -- --config-dir "$HOME/.imap-mcp" list
```

Both `.key` and `accounts.json` must be moved/backed up together. A missing or
invalid key is rejected rather than replaced when an account store exists.
Account updates reload the current store under a cross-process lock and replace
`accounts.json` atomically, so host CLI and MCP writes preserve each other's
accounts. Mount the **directory**, since a file bind mount would keep an old
inode after atomic replacement. For manual JSON edits, stop writers first and
preserve the encrypted password fields. If a process is killed during a write,
remove `.accounts.lock` only after stopping all writers; malformed JSON is
rejected without overwriting it. Restart after changes to credentials/connection
settings to refresh cached IMAP/SMTP connections; account lists reload live.

## Docker and HTTP MCP

Compose publishes only **`127.0.0.1:47863`**, a deliberately uncommon host port,
to container port `8787`. The endpoint is `http://127.0.0.1:47863/mcp`; change
`IMAP_MCP_LOCAL_PORT` if it is occupied. The app binds `0.0.0.0` inside the
container so Docker can reach it. A reverse proxy running on the host can reach
the loopback publication; a proxy in another container needs its own network
configuration rather than treating its own `127.0.0.1` as the Docker host.

| Host file/directory | Container path | Purpose |
| --- | --- | --- |
| `IMAP_MCP_CONFIG_DIR` (default `.imap-mcp/`) | `/data/config` (read/write) | Shared encrypted accounts and `.key` |
| `IMAP_MCP_DOWNLOAD_DIR` (default `downloads/`) | `/data/attachments` (read/write) | Downloads and uploaded attachments |
| `credentials.env` (optional) | Process environment | Runtime-only account credential overrides |

The configuration and attachment directories are bind mounts so the host CLI,
editors and MCP tools use the same underlying files. No anonymous Docker volume
hides configuration from the host. In HTTP mode, attachment save paths must
stay inside `/data/attachments`; symbolic links are rejected. Local stdio retains
caller-selected save paths. Compose refuses to create missing bind paths;
run `init` first. The container uses your non-root UID/GID, a read-only root
filesystem, dropped capabilities, `no-new-privileges`, temporary `/tmp`, bounded
logs and a liveness check at `/healthz`. `.key` and `accounts.json` are owner-only,
with private file permissions. OAuth signing keys are fetched from the configured
Keycloak realm; no authentication client secret or static token is stored here.

### OAuth authorization

HTTP uses the MCP server as an OAuth resource server and your Keycloak realm as
its authorization server, following the [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
and [RFC 9728 protected resource metadata](https://www.rfc-editor.org/rfc/rfc9728.html).
Keycloak handles user login, consent, authorization-code exchange with S256 PKCE,
client registration and refresh. The MCP server does not proxy these operations.
The realm must issue the exact resource audience through a scope-linked Audience
mapper, as described in [Keycloak's official MCP guide](https://www.keycloak.org/securing-apps/mcp-authz-server).
That guide documents the released provider's RFC 8707 limitation; audience
mapping provides resource binding without claiming full provider conformance.
Predefined OAuth clients work with ChatGPT; client metadata documents require
Keycloak's experimental CIMD support, while DCR needs realm registration policies.

| Environment variable | Meaning |
| --- | --- |
| `IMAP_MCP_OAUTH_ISSUER` (required) | Exact public realm issuer, e.g. `https://auth.example.com/realms/mail-mcp`, without trailing slash |
| `IMAP_MCP_OAUTH_RESOURCE_URL` (required) | Canonical public MCP URL ending in `/mcp`, e.g. `https://mail-mcp.example.com/mcp`; also the exact required token audience |
| `IMAP_MCP_OAUTH_SCOPES` | Space-separated scopes, all required on every MCP request; default `imap:access` |
| `IMAP_MCP_OAUTH_ALLOW_INSECURE_HTTP` | Default `false`; `true` permits HTTP OAuth URLs for isolated testing only |

`IMAP_MCP_TRANSPORT=http` enables HTTP outside Compose; stdio remains the default
and uses local process access control. HTTP defaults to host `127.0.0.1`, port
`8787`. OAuth URLs come from configuration, never Host/forwarded headers or token
claims. HTTPS is required by default. The server discovers the realm's
`/.well-known/openid-configuration` at startup, checks its exact issuer and
requires a JWKS URL on the same origin, authorization-code support and S256 PKCE.
Discovery failures prevent startup.
`npm run setup -- oauth-check` validates the current environment and discovery;
it does not prove login/token issuance or fetch signing keys.

Unauthenticated `/mcp` requests return `401` with a `WWW-Authenticate` challenge
containing `resource_metadata` and the required `scope`. Public metadata is at
`/.well-known/oauth-protected-resource/mcp` and the root fallback
`/.well-known/oauth-protected-resource`. For a public URL such as
`https://mail.example.com/service/mcp`, the path-specific metadata is instead
`/.well-known/oauth-protected-resource/service/mcp`. Both advertise the exact
resource, Keycloak issuer, supported scopes and header-only bearer tokens.
Keycloak serves its own authorization-server discovery; no local fake issuer or
registration endpoint is advertised.

Each MCP request must supply `Authorization: Bearer <access_token>`. The verifier
uses `jose` and realm JWKS to verify RS256 signatures, exact `iss`, exact `aud`,
mandatory `exp`, `iat`, `sub`, `azp`, Keycloak access-token `typ=Bearer`, and any
`nbf`. ID/refresh tokens, expired/future tokens, query/cookie credentials and
duplicate/malformed Authorization headers are rejected. Invalid tokens return
`401 invalid_token`; valid tokens lacking a required scope return
`403 insufficient_scope` with scope and metadata guidance. Signing keys are cached
for five minutes and refreshed for unknown keys after a 30-second cooldown.
Key retrieval uses a five-second timeout and rejects redirects.

Tokens remain in request memory and are never logged, persisted or forwarded to
mail servers. The official SDK receives verified authentication context. Refresh
is the MCP client's responsibility; after refresh, the new token is verified on
its next request. This uses local JWT validation, not online introspection:
Keycloak logout/revocation or role removal does not invalidate already-issued
JWTs immediately. Use short access-token lifetimes to bound this interval.

An authorized user has access to **all accounts and enabled tools** in this
server's shared store. OAuth does not add per-user mailbox isolation. Restrict
who receives the required scope in Keycloak. Existing `IMAP_MCP_READ_ONLY` and
`IMAP_MCP_ENABLED_TOOLS` still limit capabilities globally.

The official SDK's [Streamable HTTP transport](https://ts.sdk.modelcontextprotocol.io/server)
is stateless with JSON responses. POST handles messages; authenticated GET/DELETE
return `405`. Tool names, schemas and outputs retain their API. `/healthz` is a
minimal public liveness response.

### Reverse proxy and migration

Terminate HTTPS and forward `/mcp` plus **both metadata paths** to the application.
For a path prefix, forward the canonical public MCP path to local `/mcp` and
preserve the full path-specific well-known URL. Preserve `Host`, `Authorization`,
`Origin`, `Accept`, `Content-Type` and MCP protocol headers. Do not log credentials
or request bodies. Add the public hostname to `IMAP_MCP_ALLOWED_HOSTS` (exact
hostname, no scheme/port/wildcard). Forwarded headers never bypass validation.

Origin-bearing MCP requests are rejected by default. Add exact browser origins
to `IMAP_MCP_ALLOWED_ORIGINS` when needed. The app then handles unauthenticated
OPTIONS preflight and exposes `WWW-Authenticate` through CORS. Tool requests
still require a valid access token. Public metadata supports discovery CORS for
any origin, while retaining Host validation. Native clients usually omit Origin.

Example nginx locations in the HTTPS virtual host for `mail-mcp.example.com`:

```nginx
location = /mcp {
    proxy_pass http://127.0.0.1:47863;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header Origin $http_origin;
    proxy_buffering off;
    proxy_read_timeout 300s;
    client_max_body_size 40m;
}
location = /.well-known/oauth-protected-resource {
    proxy_pass http://127.0.0.1:47863;
    proxy_set_header Host $host;
}
location = /.well-known/oauth-protected-resource/mcp {
    proxy_pass http://127.0.0.1:47863;
    proxy_set_header Host $host;
}
```

Static bearer authentication, `imap-setup token`, token generation and the Compose
bearer secret mount have been removed. Remove `IMAP_MCP_TOKEN_FILE`,
`IMAP_MCP_BEARER_TOKEN_FILE` and `IMAP_MCP_BEARER_TOKEN` from deployment settings,
add the OAuth variables, configure Keycloak, update proxy discovery routes and
configure the client's OAuth registration. Old token files are unused and may
be removed after migration; account stores and keys remain unchanged. Legacy
runtime bearer variables cause a startup error rather than enabling a fallback.
Recreate the container with `docker compose up --build -d --force-recreate`.
Changes to `credentials.env` also require recreating the container.

`docker compose down` preserves host data. `npm run test:docker` runs an isolated
Compose smoke test with a local signing fixture and temporary accounts, without
contacting mail servers. Unit/integration tests cover real signed JWT validation,
discovery, CORS and the official SDK's PKCE/refresh workflow. A production
Keycloak/client login must still be verified in your deployment.

### Overriding Credentials via Environment Variables

You can override the username and password of an already-configured account at
runtime with environment variables — useful when you inject secrets from a
password manager or CI system instead of storing them in `accounts.json`.

The variables are keyed by the account **name**, uppercased with every
non-alphanumeric character replaced by `_`. For an account named `Work Gmail`
(key `WORK_GMAIL`):

| Variable | Overrides |
| --- | --- |
| `IMAP_MCP_ACCOUNT_WORK_GMAIL_IMAP_USERNAME` | IMAP username (`user`) |
| `IMAP_MCP_ACCOUNT_WORK_GMAIL_IMAP_PASSWORD` | IMAP password |
| `IMAP_MCP_ACCOUNT_WORK_GMAIL_SMTP_USERNAME` | SMTP username (`smtp.user`) |
| `IMAP_MCP_ACCOUNT_WORK_GMAIL_SMTP_PASSWORD` | SMTP password |

Notes:
- Overrides apply **only to existing accounts**; if no account's normalized name
  matches, the variable is ignored.
- They are applied **in memory only** — nothing is written back to
  `accounts.json`, and the values are used as-is (not re-encrypted).
- Variables are **consumed at startup**: on server start they are captured into
  an AES-256-encrypted in-memory cache and removed from `process.env`, so the
  plaintext secret does not linger in the environment (where it could leak to
  child processes or diagnostics). Set them before launching the server.

The CLI prompts for whether to supply each credential via the environment, or
accepts `imapUsernameFromEnv`, `imapPasswordFromEnv`, `smtpUsernameFromEnv`, and
`smtpPasswordFromEnv` in JSON input. It stores empty placeholders and prints the
exact variable names to supply. In Docker, copy `credentials.env.example` to
`credentials.env`, set only the needed values, and restrict it to mode `0600`.
Compose loads this optional file with `format: raw`, so `$` and quotes in a
password are literal; do not add shell quoting. The normal `.env` configures
Compose paths/settings and **does not** inject arbitrary account credential
variables into the container. These belong in `credentials.env`.
- SMTP variables take effect only when the account already has an SMTP config.
- Each variable takes effect independently; set only the ones you need.

**If the variable is missing**, the account still holds the empty placeholder the
CLI wrote. Rather than dialing out with a blank credential — which providers
answer with a generic authentication failure that looks exactly like a wrong
password — the server refuses the connection and names what to set:

```
Account "Work Gmail" has IMAP credentials marked as environment-managed, but
this variable was not set when the server started:
IMAP_MCP_ACCOUNT_WORK_GMAIL_IMAP_PASSWORD. Set it and restart the server, or
store the credentials on the account via imap_update_account.
```

Because the variables are read once at startup, setting one in an already-running
shell has no effect until the server is restarted.

### Supported Email Providers

The CLI includes pre-configured settings for:
- Gmail / Google Workspace
- Microsoft Outlook / Hotmail / Live
- Yahoo Mail
- Apple iCloud Mail
- GMX
- WEB.DE
- IONOS (1&1)
- ProtonMail (with Bridge)
- Fastmail
- Zoho Mail
- AOL Mail
- mailbox.org
- Posteo
- Custom IMAP servers

## Configuration

### Claude Code (CLI)

#### Option A — via npx (no clone/build needed)

```bash
claude mcp add imap -- npx -y imap-mcp-server
```

This always runs the latest published version and requires no local build.

#### Option B — from a local clone

If you use [Claude Code](https://docs.anthropic.com/en/docs/claude-code) in the terminal, add the MCP server with a single command:

**Step 1:** Make sure you have built the project first (see [Manual Installation](#manual-installation)).

**Step 2:** Run this command in your terminal:

```bash
claude mcp add imap -- node /absolute/path/to/imap-mcp-server/dist/index.js
```

> **Important:** Replace `/absolute/path/to/imap-mcp-server` with the actual path where you cloned the repository. For example:
> ```bash
> # macOS/Linux example:
> claude mcp add imap -- node /Users/yourname/imap-mcp-server/dist/index.js
>
> # Windows example:
> claude mcp add imap -- node C:\Users\yourname\imap-mcp-server\dist\index.js
> ```

**Step 3:** Verify it was added:

```bash
claude mcp list
```

You should see `imap` in the list of configured MCP servers. That's it — the IMAP tools are now available in your Claude Code sessions.

> **Tip:** If you want to remove the server later, run:
> ```bash
> claude mcp remove imap
> ```

### Claude Desktop (GUI App)

Add the IMAP MCP server to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

**Option A — via npx (recommended, no clone/build needed):**

```json
{
  "mcpServers": {
    "imap": {
      "command": "npx",
      "args": ["-y", "imap-mcp-server"],
      "env": {}
    }
  }
}
```

**Option B — from a local clone:**

```json
{
  "mcpServers": {
    "imap": {
      "command": "node",
      "args": ["/path/to/imap-mcp-server/dist/index.js"],
      "env": {}
    }
  }
}
```

### Restricting tool access (read-only mode / allowlist)

By default all tools are exposed. You can restrict which tools the agent sees
using two environment variables (set them under the `env` key of your MCP
config). This is useful when you want to give an assistant **read-only** access
to a mailbox, or expose only a hand-picked subset of tools.

| Variable | Effect |
| --- | --- |
| `IMAP_MCP_READ_ONLY` | When truthy (`1`, `true`, `yes`, `on`), only the safe, read-only tools are registered — searching, reading, listing folders, unread counts, spam analysis. No tool that sends mail, deletes/moves messages, changes flags, or edits accounts is exposed. |
| `IMAP_MCP_ENABLED_TOOLS` | Comma-separated allowlist of tool names — only these are registered. Names are case-insensitive and the `imap_` prefix is optional (`search_emails` ≡ `imap_search_emails`). When set, it takes precedence over `IMAP_MCP_READ_ONLY`. |

**Example — read-only access:**

```json
{
  "mcpServers": {
    "imap": {
      "command": "npx",
      "args": ["-y", "imap-mcp-server"],
      "env": { "IMAP_MCP_READ_ONLY": "true" }
    }
  }
}
```

**Example — explicit allowlist:**

```json
{
  "mcpServers": {
    "imap": {
      "command": "npx",
      "args": ["-y", "imap-mcp-server"],
      "env": { "IMAP_MCP_ENABLED_TOOLS": "imap_search_emails,imap_get_email,imap_get_latest_emails" }
    }
  }
}
```

The read-only subset is: `imap_list_accounts`, `imap_connect`, `imap_disconnect`,
`imap_test_account`, `imap_search_emails`, `imap_get_email`,
`imap_get_latest_emails`, `imap_download_attachment`, `imap_find_thread_messages`,
`imap_find_email_by_message_id`, `imap_list_folders`, `imap_folder_status`,
`imap_get_unread_count`, `imap_check_spam`, `imap_domain_stats`,
`imap_list_spam_domains`.

## Usage

Once configured, the IMAP MCP server provides the following tools in Claude:

> **Choosing an account.** For the email and folder tools, `accountId` is
> **optional** and backward-compatible. You may instead pass `accountName`, and
> if you only have a **single** account configured you can omit both — that
> account is used by default. With multiple accounts and no selector, the tool
> returns a clear error listing your options (`imap_list_accounts`).

### Account Management

- **imap_add_account**: Add a new IMAP account
  ```
  Parameters:
  - name: Friendly name for the account
  - host: IMAP server hostname
  - port: Server port (default: 993)
  - user: Username
  - password: Password
  - tls: Use TLS/SSL (default: true)
  - allowStartTLS: When tls is false, set to false to also disable the
      opportunistic STARTTLS upgrade imapflow otherwise attempts whenever the
      server advertises it (validating the cert against `host` regardless of
      `tls`). Needed for providers that advertise STARTTLS on a hostname
      covered only by a shared/wildcard cert. Defaults to true.
  - sentFolder: Explicit Sent-folder name for sent-mail copies, e.g. "Gesendet"
      (optional — only needed when the server has no \Sent SPECIAL-USE folder
      and auto-detection fails)
  - defaultBcc: Optional BCC address(es) applied automatically to every
      outbound send, reply, forward, and draft for this account. Merged with
      any per-call `bcc` (duplicates removed case-insensitively)
  ```

- **imap_update_account**: Update an existing account (fix SMTP settings, rename, etc.)
  ```
  Parameters:
  - accountId: ID of the account to update
  - name, host, port, user, password, tls, allowStartTLS, email: IMAP fields (all optional)
  - smtpHost, smtpPort, smtpSecure, smtpUser, smtpPassword: SMTP fields (optional)
  - saveToSent: Save sent emails to the Sent folder (optional)
  - sentFolder: Explicit Sent-folder override (optional). Pass an empty string
      to clear the override and re-enable auto-detection
  - defaultBcc: Optional default BCC address(es) (optional). Pass an empty
      string to clear
  ```

- **imap_list_accounts**: List all configured accounts

- **imap_remove_account**: Remove an account
  ```
  Parameters:
  - accountId: ID of the account to remove
  ```

- **imap_connect**: Connect to an account
  ```
  Parameters:
  - accountId OR accountName: Account identifier
  ```

- **imap_disconnect**: Disconnect from an account
  ```
  Parameters:
  - accountId: Account to disconnect
  ```

### Email Operations

- **imap_search_emails**: Search for emails
  ```
  Parameters:
  - accountId: Account ID
  - folder: Folder name (default: INBOX; ignored when searchAllFolders is true)
  - searchAllFolders: Search across ALL folders at once (default: false).
      Skips Trash/Spam/Drafts and non-selectable folders by default. Use when a
      message may have been filed/moved/archived and you don't know its folder.
  - includeTrash, includeSpam, includeDrafts: Opt those noisy folders back into
      a searchAllFolders run (default: false each)
  - from, to, subject, body: Search criteria
  - since, before: Date filters
  - seen, flagged: Status filters
  - keywords: Match messages with ANY of these custom keywords (server-side OR).
      Read a mailbox's available custom keywords from `imap_folder_status`'s
      `customKeywords` field first.
  - unKeywords: Exclude messages with ANY of these custom keywords (result has
      NONE of them). Same keyword source as `keywords`.
  - limit: Max results (default: 50)
  - includeBody: Include parsed message body in the response (default: false).
      Fetches the RFC822 source once and parses it with mailparser, so you get
      uid + body in a single tool call instead of paying the N+1 cost of one
      `imap_get_email` per match. Body is rendered per `bodyFormat` and capped
      at `bodyMaxLength` per field.
  - bodyFormat: How to render the body when `includeBody` is true — `markdown`
      (default, clean Markdown via Turndown), `text`, `html`, or `auto`.
  - bodyMaxLength: Per-field cap when `includeBody` is true (default: 10000).
  ```
  > With `searchAllFolders`, results include a `folder` field per message plus
  > `foldersSearched`, and any folder that failed to open is reported in
  > `foldersErrored` (so a 0-result answer is never silently incomplete).
  >
  > `includeBody` is honored in the single-folder path only. For a
  > cross-folder sweep the lightweight header shape is preserved by design —
  > pulling RFC822 source for every match across many folders would multiply
  > bandwidth and parse cost. Follow up with `imap_get_email` for the specific
  > uids whose bodies you need.
  >
  > On some servers a "flagged"/starred message carries a custom keyword (e.g.
  > an Open-Xchange color label or Apple's `$MailFlagBit*`) instead of, or in
  > addition to, the `\Flagged` system flag — after any flagged search, check
  > each result's `customKeywords` field before concluding a message is or
  > isn't flagged.

- **imap_get_email**: Get full email content
  ```
  Parameters:
  - accountId: Account ID
  - folder: Folder name
  - uid: Email UID
  - maxContentLength: Max characters for text/html body (default: 10000)
  - includeAttachmentText: Include text attachment previews (default: true)
  - maxAttachmentTextChars: Max characters per text attachment (default: 100000)
  ```

- **imap_get_latest_emails**: Get recent emails
  ```
  Parameters:
  - accountId: Account ID
  - folder: Folder name (default: INBOX)
  - count: Number of emails (default: 10)
  - includeBody: Include parsed message body (default: false). Same semantics
      as the `includeBody` option on `imap_search_emails` — one round-trip
      instead of N×`imap_get_email`.
  - bodyFormat: `markdown` (default), `text`, `html`, or `auto`.
  - bodyMaxLength: Per-field cap (default: 10000).
  ```

- **imap_mark_as_read/unread**: Change email read status
  ```
  Parameters:
  - accountId: Account ID
  - folder: Folder name
  - uid: Email UID, OR an array of UIDs to flag in one call. Batch uses a
      single IMAP STORE so the operation is atomic at the server level — all
      UIDs are flagged, or none. Useful when triaging many messages at once.
  ```

- **imap_flag_email/unflag_email**: Star/unstar an email (sets or clears the IMAP \Flagged system flag — shows as a "star" in Gmail and Apple Mail). Some servers/clients (Open-Xchange, Apple Mail) also set a separate custom keyword (e.g. `$cl_N`, `$MailFlagBit*`) when flagging; unflag only clears `\Flagged`, so if a message still shows as flagged, check `customKeywords` via `imap_get_email` and clear it with `imap_remove_keyword`.
  ```
  Parameters:
  - accountId: Account ID
  - folder: Folder name
  - uid: Email UID
  ```

- **imap_add_keyword/remove_keyword**: Set or clear an arbitrary *custom* (non-system) IMAP keyword/label on an email, passed through verbatim (e.g. provider color labels like Open-Xchange's `$cl_1`..`$cl_10` or Apple Mail's `$MailFlagBit0`..`$MailFlagBit2`, or any other custom keyword). Backslash-prefixed system flags (e.g. `\Flagged`, `\Seen`, `\Deleted`) are rejected — use the dedicated flag/read tools for those. Not every server permits custom-keyword changes (see the mailbox's PERMANENTFLAGS); if the server rejects or silently ignores the change, the call fails instead of reporting success.
  ```
  Parameters:
  - accountId: Account ID
  - folder: Folder name
  - uid: Email UID
  - keyword: IMAP keyword to set/remove (e.g. "$cl_3")
  ```

- **imap_delete_email**: Delete an email
  ```
  Parameters:
  - accountId: Account ID
  - folder: Folder name
  - uid: Email UID
  ```

- **imap_move_email**: Move an email from one folder to another
  ```
  Parameters:
  - accountId: Account ID
  - folder: Source folder name (default: INBOX)
  - uid: Email UID, OR an array of UIDs to move in one call. Batch moves are
      attributed per-uid in the response (`results[]` with per-uid `uidMap`
      and any errors). Single-uid calls return the legacy response shape.
  - targetFolder: Destination folder name
  - createDestinationIfMissing: Create the destination folder if it does not exist (default: false)
  ```

- **imap_find_thread_messages**: Find inbox messages that belong to the same conversation threads as messages already sorted into another folder. Uses RFC 3501 HEADER search on In-Reply-To and References — works on any IMAP server.
  ```
  Parameters:
  - accountId: Account ID
  - sourceFolder: Folder containing the already-sorted thread messages
  - searchFolder: Folder to search for related messages (default: INBOX)
  - searchReferences: Also match the References header for multi-level threads (default: true)
  - includeBody: Include parsed message body for each found thread message
      (default: false). Same semantics as the `includeBody` option on
      `imap_search_emails` — one round-trip instead of N×`imap_get_email`.
  - bodyFormat: `markdown` (default), `text`, `html`, or `auto`.
  - bodyMaxLength: Per-field cap (default: 10000).
  ```

- **imap_download_attachment**: Download an email attachment (returns images inline, extracts text from PDFs, or saves to downloads directory)
  ```
  Parameters:
  - accountId: Account ID
  - folder: Folder name (default: INBOX)
  - uid: Email UID
  - filename: Attachment filename or contentId (as listed by imap_get_email; NFC/NFD
      spellings of accented characters are treated as equal, and a contentId may
      be passed with or without angle brackets)
  - savePath: Optional file path to save the attachment to
  - extractText: For PDFs, extract and return text content inline (default: true)
  ```

- **imap_bulk_delete**: Delete multiple emails at once with chunking and auto-reconnection
  ```
  Parameters:
  - accountId: Account ID
  - folder: Folder name (default: INBOX)
  - uids: Array of email UIDs to delete
  - chunkSize: Emails to delete per batch (default: 50)
  ```

- **imap_bulk_delete_by_search**: Search for emails matching criteria and delete them all
  ```
  Parameters:
  - accountId: Account ID
  - folder: Folder name (default: INBOX)
  - from, to, subject: Search criteria (optional)
  - before, since: Date filters (optional)
  - chunkSize: Emails to delete per batch (default: 50)
  - dryRun: Preview what would be deleted without deleting (default: false)
  ```
  At least one concrete criterion (`from`, `to`, `subject`, `before`, or `since`)
  is required — a call with no criteria is refused, so it can never match and
  delete an entire folder. On servers whose SEARCH is broken (see
  Troubleshooting → Search returns nothing) this tool, `imap_delete_spam` and
  `imap_delete_by_domain` return an error instead of deleting from a
  client-side match.

- **imap_send_email**: Send a new email
  ```
  Parameters:
  - accountId: Account ID to send from
  - to: Recipient email address(es) — an array, or a single comma-separated string
  - subject: Email subject
  - text: Plain text content (optional)
  - html: HTML content (optional)
  - cc: CC recipients (optional)
  - bcc: BCC recipients (optional)
  - replyTo: Reply-to address (optional)
  - attachments: Array of attachments (optional)
    - filename: Attachment filename
    - content: Base64 encoded content; provide exactly one of `content` or `path`
    - path: Readable local file path to attach; provide exactly one of `path` or `content`
    - contentType: MIME type (optional; detected from the filename extension when omitted)
    - contentDisposition: "attachment" (default) or "inline" — use "inline" for images shown in the HTML body via cid:
    - cid: Content-ID for inline attachments; must match the `cid:` value used in an `<img src="cid:...">` tag in `html`
  - dryRun: Validate attachments and compose MIME without sending or saving to Sent (optional, default: false)
  ```
  Attachments are validated before SMTP is contacted. Invalid base64, unreadable
  paths, missing filenames, ambiguous sources, and inline attachments without
  `cid` fail fast. Successful sends and dry-runs return `attachmentCount` and
  safe `attachmentDiagnostics`: filename, MIME type, size, source, disposition,
  and cid. Diagnostics omit bytes, raw MIME, and local file paths.

  For large files, upload with `imap_upload_file` first and pass its returned
  local `path`; for inline images, set `contentDisposition: "inline"` and a
  matching `cid`.

  After sending, a copy is saved to the account's Sent folder (unless
  `saveToSent` is disabled on the account). The folder is resolved via the
  account's `sentFolder` override → the server's `\Sent` SPECIAL-USE flag →
  a list of known localized names ("Sent", "Gesendet", "Éléments envoyés", …).
  The response reports the outcome: `savedToSent` (boolean), `sentFolder`
  (the folder used), and — when the save fails — `sentSaveError` explaining
  why, instead of failing silently. The same applies to `imap_reply_to_email`
  and `imap_forward_email`.

  When the account has `defaultBcc` configured, those address(es) are always
  BCC'd on send, reply, forward, and draft (merged with any per-call `bcc`;
  duplicates removed case-insensitively). The Bcc header is kept in the MIME
  stored for drafts and Sent-folder copies so mail clients show it.

- **imap_save_draft**: Save an email as a draft (no send). Takes the same fields as `imap_send_email`, plus `inReplyTo`, `references`, and an optional `folder` override for the Drafts folder.

- **imap_reply_to_email**: Reply to an existing email
  ```
  Parameters:
  - accountId: Account ID
  - folder: Folder containing the original email
  - uid: UID of the email to reply to
  - text: Plain text reply content (optional)
  - html: HTML reply content (optional)
  - replyAll: Reply to all recipients (default: false)
  - bcc: BCC recipients (optional; merged with account defaultBcc)
  - attachments: Array of attachments (optional, same shape as imap_send_email, including contentDisposition/cid for inline images)
  ```

- **imap_forward_email**: Forward an existing email
  ```
  Parameters:
  - accountId: Account ID
  - folder: Folder containing the original email
  - uid: UID of the email to forward
  - to: Forward to email address(es)
  - text: Additional text to include (optional)
  - bcc: BCC recipients (optional; merged with account defaultBcc)
  - includeAttachments: Include original attachments (default: true)
  ```

### Folder Operations

- **imap_list_folders**: List all folders
  ```
  Parameters:
  - accountId: Account ID
  ```
  Each folder includes its `attributes` (raw IMAP LIST flags) and, when the
  server advertises it, `specialUse` — the RFC 6154 role (`\Sent`, `\Drafts`,
  `\Trash`, `\Junk`, `\Archive`) that identifies a folder independent of its
  localized display name (e.g. "Gesendet" carries `specialUse: "\Sent"`).

- **imap_folder_status**: Get folder information
  ```
  Parameters:
  - accountId: Account ID
  - folder: Folder name

  Returns:
  - messages: { total, new, unseen } — from IMAP STATUS
  - uidvalidity, uidnext
  - flags, permanentFlags: string arrays
  - customKeywords: the mailbox's non-system keywords, usable as the
      `keywords` / `unKeywords` input of imap_search_emails
  ```

- **imap_create_folder**: Create a new IMAP folder/mailbox. Most servers also create any missing parent folders. Returns success even if the folder already exists.
  ```
  Parameters:
  - accountId: Account ID
  - folder: Full folder path to create (e.g. "Archives/2026/2026-05" or "INBOX.Archive")
  ```

- **imap_get_unread_count**: Count unread emails
  ```
  Parameters:
  - accountId: Account ID
  - folders: Specific folders (optional)
  ```

## Security

- Credentials are encrypted using AES-256-CBC encryption
- Encryption keys are stored separately in `~/.imap-mcp/.key`
- Account configurations are stored in `~/.imap-mcp/accounts.json`
- The store directory, `.key`, and `accounts.json` are written owner-only
  (`0700`/`0600`) so other local users cannot read the key or the credentials
- HTTP MCP requires a realm-issued OAuth access token with the resource audience and required scope; CLI account output omits passwords
- The image contains neither configuration nor credentials; persistence uses host bind mounts
- Downloaded attachments are confined to the downloads directory; sender-supplied
  filenames cannot write outside it
- Never commit or share your encryption key or account configurations

## Development

### Running in Development Mode

```bash
npm run dev
```

### Building

```bash
npm run build
```

### Project Structure

```
src/
├── index.ts           # MCP server entry point
├── services/
│   ├── imap-service.ts    # IMAP connection management
│   ├── smtp-service.ts    # SMTP service for sending emails
│   └── account-manager.ts # Account configuration
├── tools/
│   ├── index.ts          # Tool registration
│   ├── account-tools.ts  # Account management tools
│   ├── email-tools.ts    # Email operation tools (including send/reply/forward)
│   └── folder-tools.ts   # Folder operation tools
└── types/
    └── index.ts          # TypeScript type definitions
```

## Example Usage in Claude

1. **Add an account:**
   "Add my Gmail account with username john@gmail.com"

2. **Check new emails:**
   "Show me the latest 5 emails from my Gmail account"

3. **Search emails:**
   "Search for emails from boss@company.com in the last week"

4. **Send an email:**
   "Send an email to client@example.com with subject 'Project Update'"

5. **Reply to emails:**
   "Reply to the latest email from my boss"

6. **Forward emails:**
   "Forward the email with subject 'Meeting Notes' to team@company.com"

7. **Move an email:**
   "Move the invoice email from INBOX to my Taxes folder"

8. **Manage folders:**
   "List all folders in my email account and show unread counts"

## Troubleshooting

### Connection Issues

- Ensure your IMAP server settings are correct
- Check if your email provider requires app-specific passwords
- Verify that IMAP is enabled in your email account settings
- For sending emails, ensure your account has SMTP access enabled

### Recipients arriving as `["a@x.com","b@y.com"]`

`to`, `cc`, `bcc`, `references` and `uid` accept either a single value or an
array. In JSON Schema that is an `anyOf`, and some MCP clients drop the `anyOf`
before showing the schema to the model — the field then looks untyped or
string-typed, and the client serializes the model's array into a string. The
server used to pass that string straight to nodemailer, which folded the
literal `[` and `]` into the first and last address, so every recipient was
rejected by the receiving mail server (issue #127).

The server now detects a stringified array and restores it, both when
validating tool input and again before composing the message, and logs a
warning to stderr naming the field. Nothing needs to change on your side. If
you want to bypass the client behavior entirely, pass recipients as one
comma-separated string: `"Alice <alice@example.com>, Bob <bob@example.org>"`.

### Search returns nothing although the folder has mail (Strato)

Since mid-2026 Strato's IMAP server (`imap.strato.com`) answers every SEARCH
command with an empty result, while FETCH still works (issue #138). The server
detects this: when a SEARCH comes back empty for a folder that is not empty and
`SEARCH ALL` is empty as well, it fetches the envelopes and applies the
criteria itself. `imap_search_emails`, `imap_find_thread_messages`, the unread counts and the
spam analysis keep working; `imap_get_latest_emails` never needed SEARCH.

Limits of the fallback:

- It is slower — every envelope of the folder is downloaded per search.
- A `body` search downloads and parses each remaining candidate, so it is
  refused above 2000 candidates; narrow it with `since`/`from`/`subject`.
- Deleting tools (`imap_bulk_delete_by_search`, `imap_delete_spam`,
  `imap_delete_by_domain`) do **not** use it and return an error instead. Find
  the messages with `imap_search_emails` and delete their UIDs with
  `imap_bulk_delete`.

### SMTP Configuration

The server automatically configures SMTP settings based on your IMAP provider. If you need custom SMTP settings, you can specify them when adding an account:

```json
{
  "smtp": {
    "host": "smtp.example.com",
    "port": 587,
    "secure": false
  }
}
```

### Common IMAP Settings

- **Gmail**: 
  - Host: imap.gmail.com
  - Port: 993
  - Requires app-specific password

- **Outlook/Hotmail**:
  - Host: outlook.office365.com
  - Port: 993

- **Yahoo**:
  - Host: imap.mail.yahoo.com
  - Port: 993
  - Requires app-specific password

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
