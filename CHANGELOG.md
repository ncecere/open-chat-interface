# Changelog

All notable changes to Open Chat Interface are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Fixes from eight QA walks of v0.11.0 (issues #35–#353). Two migrations, `0042`
and `0043` (code artifacts, #298), run with `migrate` as usual. Four new
post-deploy steps run with `migrate --post` after every replica runs the new
release, as for any release: `0007`, `0008` and `0010` index the audit log so
a person's trail includes bulk actions done to them and entries made with
their address alone (#216, #342; until they run, the trail is complete but
slower on a large audit log), and `0009` enables code artifacts (#298; until it runs, code stays in the reply, so a replica of the
previous release never sees the new kind). The PostgreSQL driver patch
(`patches/postgres@3.4.9.patch`) is applied by `pnpm install`.

### Added

- **Send test email** on Settings → Email delivery, which also says whether an
  SMTP username and password are stored (#115). `POST
  /api/admin/settings/smtp/test`; `smtp.hasUsername` and `smtp.hasPassword` in
  the settings.
- **Edit scheduled reports**, and see when each is next sent (#85).
- **Unsaved-changes protection** in administration: leaving a page, closing
  the tab or pressing Escape in a half-filled dialog asks first (#45).
- **Acceptable-use drafts** can be read, reworded and deleted before they are
  published (#40).
- **Undo for archiving** a conversation, and confirmations before deleting an
  attachment or a memory (#101).
- **Formatting in announcements**: bold and links (#86).
- **HTML versions of the account emails** (invitation, verification, password
  reset), and invitations that say who sent them, the role and when they
  expire (#78).

### Changed

- **SSO sign-in with account linking off** now works: OCI enforces linking
  itself instead of through domain verification, which refused every sign-in
  (#36, migration `0042`).
- **Large project files are searched in full**, with a warning above the
  limit, instead of only their first 200,000 characters (#35); meaning-based
  search keeps only passages close to the best match (#65).
- **Limits are named by what they count** ("message limit for today"), not by
  the administrator's budget name (#93).
- **The sidebar is a drawer below 1024 px** (it docked from 768 px) (#109).
- **A refused message keeps its text** in the composer (#62); a restarting
  replica refuses a new turn with the error code `SERVER_RESTARTING` (#118).
- **Invitations** refuse existing accounts and duplicates and expire after 7
  days by default (#51); **settings are validated on the server** (#50).
- **Upload size** on Storage is set in MB, as on Roles & access (#86).
- **Automatic titles** end on a whole word, without "..." (#100).
- **Settings → Devices** shows real last activity, to within five minutes
  (#98).
- **The demo seed** uses the instance's own administrator and dates its data
  from the day it runs (`DEMO_NOW`, `DEMO_ADMIN_EMAIL`) (#116).

### Fixed

- **Security and access:** keyless OpenAI providers and removing the default
  model are refused (#49); new models are not offered to auditors by default
  (#48); bulk-granting administrator access asks first (#47); an OIDC
  provider that cannot be added says why instead of failing with a 500 (#37);
  SAML certificates and SSO domains are validated, and providers start
  disabled (#53, partly; see the issue).
- **Audit:** actions taken on an account appear in its trail (#39); delete
  and revoke entries record what was removed (#52); filters that match
  nothing say so (#56).
- **Storage allowances** of 0 or less are refused instead of saved as
  unlimited (#38).
- **Accounts:** a new account loads fully after signing out and in again
  (#43); the sidebar's non-working New profile button is gone (#67); you
  cannot demote yourself, and the role control says why (#76).
- **Chat:** keyboard focus returns to a dialog's opener (#41); full-screen
  tables are opaque and keep focus (#42, #74); attachments over the limits
  are refused as they are added, with the reason shown (#63, #64); a stopped
  artifact is not summarised as created (#60); web search steps show their
  sources (#61); temporary-chat mode shows only where it applies (#66) and
  Move to project is not offered for it (#91); the reasoning control shows
  only for models with levels (#95); "reply pending" no longer shows while
  the reply is replaying (#90); an interrupted reply says it is being
  recovered (#121); unavailable conversations offer no actions that would
  fail (#103).
- **Operations:** a draining single replica stays reachable through the
  proxy and lets replay readers finish (#117); a stopped worker is reported
  as such, not as "no Redis" (#119); webhooks queued while no worker ran go
  out when one starts (#120); an unknown lifecycle job is a 404 (#82);
  failed backups are reported while backups are off (#54); a new install is
  told to run `migrate --post` (#75); the release version is reported
  instead of "dev" (#55).
- **Administration:** validation errors name the field (#46); the model
  picker works by keyboard and fits phones (#70, #71); inline model rename
  saves on Enter and Add model lists every problem (#79); the Limits dialog,
  spend and window dates are formatted consistently (#80, #81, #88); webhook
  actions that match nothing are flagged (#83); connectors show the contact
  a test made (#84); auditors can read announcement messages (#87);
  announcements stay clear of the top bar (#44); the audit log and usage
  charts work on narrow screens and by keyboard (#57, #58).
- **Accessibility and layout:** WCAG AA contrast in the light theme, scanned
  in CI (#72); the stored theme applies before the first paint (#73); the
  logo input, sidebar row controls, Search toggle, theme menu, model picker,
  filter menus and Select popups have the names and roles they need (#59,
  #92, #111, #114); pages have tab titles and an h1, and truncated text has
  a tooltip (#110); settings and admin pages no longer shift while loading
  (#104); auth pages share one layout and a bad reset link offers a way back
  (#112); unavailable pages and empty lists share one layout (#113); phone
  and tablet layouts for the greeting, introduction, tab strips and
  shortcuts card (#89, #94, #102, #106, #107); Markdown tables keep their
  prose columns readable (#69); 24 px targets for attachment links (#105).
- **Wording:** sign-in errors (#97), ban reasons (#77), trait suggestions
  (#96), restricted-role pages (#99), and docs that had drifted from the
  interface (#86).

### Fixed after an eighth QA walk (#333–#353)

- **Chat:** two or more dollar amounts in a paragraph are no longer typeset
  as maths ("$5 for students, $10 for staff" reads as typed; `$x^2$` still
  renders), and a person's own messages show no maths at all (#339); the
  sidebar's New Chat leaves temporary mode like the other New Chat controls
  (#340); an empty change to preferences, a model, a person or an SSO
  provider answers 422 instead of 500 (#341); artifact card titles wrap
  (#336); a message's Edit puts focus in the text box and returns it after
  Cancel, Escape or Save (#333).
- **Audit:** a person's trail includes password-reset requests and refused
  sign-ins made with their address (#342; post-deploy step `0010` indexes
  it: run `migrate --post`); failed Test entries record why (#343); nested
  settings changes line up field by field (#344); an unban clears the ban
  reason on every path (#350); read-only entries record only the window in
  effect (#349).
- **Administration:** System health and Overview show local times and honest
  labels, with empty days included (#345, #348); an invitation reports an
  out-of-range expiry and an existing account together (#346); clearer
  messages for prices and wrong types (#347); the Users table and the Audit
  search box fit from 768 px up (#334, #335).
- **Accounts:** the verify-email page's Resend button is focusable and says
  why it is off (#337); each auth field is described once (#338).

### Fixed after a seventh QA walk (#310–#331)

- **Messages during a database outage:** a new message waits up to 10 s for
  the database to come back; if it still cannot be saved, its text goes back
  into the message box instead of showing as sent, and an uncertain failure
  is checked against the saved messages (#326).
- **Forms, everywhere:** every form shows the server's errors at their field,
  reports every problem in one save, uses the app's own messages instead of
  the browser's validation bubbles, and asks before leaving an unsaved edit,
  admin and Settings alike; guard tests keep it that way (#310, #314, #317,
  #318, #320, #321, #322).
- **Accounts and email:** Forgot password and Resend verification take the
  same time whether or not an account exists (#328); System health warns when
  email cannot be sent, and a failed reset or verification email is retried
  after 1 and 5 minutes (#327); an unverified sign-in says a link was sent,
  and resends are limited (#330); an expired or broken verification link says
  so (#329).
- **Chat:** saved conversations show formatted replies from the first paint
  on slow connections (#311); short formatted answers stay in the reply
  (#313); the greeting uses the name you gave (#315); unsent files are named
  as such (#316); the artifact panel title wraps (#312).
- **Administration:** audit entries for role changes and bans name the
  account and record what they replaced (#323); Recent activity says who did
  what to whom (#324); the Users table fits at 768 and 1024 px (#319); the
  SSO switch keeps one name (#325); read-only mode disables every write
  control (#331).

### Fixed after a sixth QA walk (#292–#308)

- **Chat:** an edited question keeps its files, shown in the edit box (#296);
  code asked for as an artifact is saved as code in its language, not an HTML
  page (#298; migration `0043` and post-deploy step `0009`); uploads left
  unsent are discarded, and a daily sweep removes old ones (#297); moving a
  conversation and deleting a project say so (#294).
- **Administration:** every admin form asks before leaving unsaved edits
  (#300); validation errors sit under their field, all at once, on every form
  (#301, #302); role changes and bans take the administrator lock, so one
  administrator always remains (#304); a role with no models says so (#303);
  times, dropdowns, "Conversations" and the running icon are consistent
  (#305).
- **Accessibility:** switches, selects and fields keep focus while saving
  (#292); controls stay uniquely named when replies open alike (#293); field
  hints are tied to their controls (#295); Customization's trait buttons say
  what they do (#299).
- **Outages:** ordinary requests are not held behind a draining API replica
  (#306); sign-in, sign-up and password reset keep their "temporarily
  unavailable" card while they re-check (#307); read-only refusals clear when
  read-only ends (#308); the database client retries a lost database within
  2 s instead of up to 20 s.

### Fixed after a fifth QA walk (#268–#289)

- **Security:** Better Auth's admin endpoints (`/api/auth/admin/*`) are
  closed: they changed roles, bans, emails and passwords, and impersonated
  people, with no audit entry and none of OCI's checks. Every account change
  goes through People → Users; administrators can no longer open a session
  as another person (#268).
- **Chat:** an edit or a fork at a question is answered with the model shown
  in the picker (#275); edited branches are titled from the revised question
  (#278); a role without artifacts is told so (#277); artifact bytes are no
  longer counted twice in file storage (#276).
- **Audit:** sign-outs and tool calls name who did them (#279, #280); edits
  to acceptable-use drafts record what changed (#284); a save that changes
  nothing is not recorded, and every Test button is (#287).
- **Administration:** server errors on Announcements, Retention, Connectors,
  Webhooks, Reports and Adjust limits show at their field, all at once (#283);
  Maintenance lists the same jobs as Background jobs (#281); a job's row
  updates right after Run (#282); budgets name models (#285); wording (#286).
- **Accessibility:** a button that disables itself while working keeps focus
  (#269); Edit name returns focus (#270); code block and table names are
  unique across a conversation, and reply headings start at h2 (#271);
  Settings' side column is in landmarks (#272); the admin not-found page
  (#273); long Select lists scroll by keyboard (#274).
- **Outages:** during a database outage, sign-in and password reset say the
  service is temporarily unavailable instead of blaming the person, and come
  back by themselves (#288); the web proxy logs one line per failed request
  instead of one per retry (#289).

### Fixed after a fourth QA walk (#239–#266)

- **Security:** database errors no longer write query parameters to the log
  (reply text, session tokens): every logged error, Better Auth's included,
  is redacted in the logger, and so is error text stored for administrators
  (#264).
- **Accessibility:** a visible focus ring on every dropdown (#239); focus
  after choosing a conversation in the phone drawer, restoring, deleting
  memories and removing attachments (#242, #250); new chats put the cursor in
  the message box, except on touch devices (#251); named task-list checkboxes
  (#240); file names wrap (#244); load errors are announced (#245); control
  names and target sizes (#246).
- **Chat:** list indentation (#241); a too-long message says the limit
  (#247); the model's "today" is the person's own date (#248); the sidebar
  picks up a title after a lost connection (#249); revoking a share link asks
  first everywhere (#252); stop notes under reasoning (#253); Markdown
  downloads nest reply headings (#255); wording (#254); an unused New Chat is
  also removed on reload or close (#266).
- **Administration:** Background jobs lists only jobs a worker runs, and Run
  says when no worker takes it (#256, #265); correcting one field keeps other
  fields' errors (#257); more edits record previous values (#258); read-only
  status reads in local time (#259); button names and disabled reasons (#260,
  #261); usage counts explained (#262); wording (#263); phone layout of
  Settings › Models and tab strips (#243).
- **Operations:** the web proxy marks a draining API replica down for 3 s,
  past the client's resends (#117 follow-up).

### Fixed after a third QA walk (#186–#237)

- **Replies and recovery:** a pending reply resolves once the API is back,
  however long it was down (#229); a reply that finished during a database
  outage is saved as complete (#231); the conversation and project-list errors
  retry by themselves (#233); a message refused during a drain leaves no empty
  conversation or "Reload saved messages" (#234); the worker waits for a
  database host that does not resolve (#230); readiness answers within a
  second during a database outage (#232).
- **Rendering:** shared conversations keep code blocks' lines and colours
  (#186); long words wrap (#187); single line breaks are kept (#207); reply
  headings start at level 2 (#212); refused artifact attempts are no longer
  shown as failed steps (#201); the web-search step shows its query, provider
  and sources (#203); search snippets drop Markdown (#206); repeated message
  and code-block controls are named for what they act on (#194).
- **Chat:** summaries work with thinking models (#202); the model is told
  today's date in the instance's reporting time zone (#204); the archive
  notice stays 10 s and while Undo has focus (#205); upload failures and
  refusals read clearly, and New Chat clears failed uploads (#208, #209); a
  fork at a question is answered and titled "Fork of …" (#213); downloads use
  the person's date (#211); the project delete dialog handles empty projects
  (#210); an emailed invitation fills in its address (#214, partly: see the
  issue).
- **Administration:** every background job is listed with Run (#215); bulk
  actions appear in a person's audit trail (#216); errors clear on edit on
  every form (#217, #226); files per message and search results are capped at
  20 (#218); audit entries record previous values (#221); read-only mode's
  reason and end are cleared and validated (#222); clearer connector,
  compliance and announcement status (#223, #224, #227); wording and button
  names (#219, #220, #228); the audit metadata block is reachable by keyboard
  (#192).
- **Accounts:** sign-in returns to the page asked for (#225); Devices says a
  signed-out device is signed out at once (#235); the verification email says
  its link lasts an hour (#236); the signed-out address reads
  `?signed-out=1` (#237).
- **Accessibility and layout:** contrast on highlighted rows (#188); focus
  after bulk actions, auth forms and in the phone drawer (#189, #190, #191);
  24 px targets (#193); no clipped text without a way to read it (#195); the
  external-link warning focuses Cancel (#196); page titles name the page
  (#197); sidebar groups are headings (#198); one dialog layout on phones
  (#199); Settings no longer shifts while loading on phones (#200).
- **Dependencies:** patched seroval, source-map-js, fast-copy and KaTeX for
  advisories published after 0.11.0.

### Fixed after a second QA walk (#125–#184)

- **Replies and resilience:** a reply cut off by a restart's drain limit, or
  stopped by the person, is saved as interrupted or stopped, not complete
  (#136); a failed reply keeps its reason and Try again after a reload (#133);
  stopping before the first word says so (#154); a refused send during a drain
  keeps its text (#161); the interrupted-reply countdown no longer stalls
  (#163); a lost connection reads "The connection to the server was lost."
  (#162); a brief database outage no longer replaces the app (#164).
- **Worker and database:** the worker no longer crashes, or hangs a job lock,
  when PostgreSQL drops a connection while the driver reads types (patched in
  `patches/postgres@3.4.9.patch`), and an unreachable database is no longer
  reported as a missing migration (#137).
- **Accounts:** a password reset ends every session (#139) and its email says
  the link lasts an hour (#184); forgot password during read-only mode says it
  is paused (#138); a session ended by a ban or Sign out everywhere returns to
  sign-in (#165); sign-in errors are announced (#183); read-only refusals give
  their reason everywhere (#159); a maintenance window's announcement hands
  over to the banner on time, with time zones named (#160).
- **Conversations:** archiving says so, with Undo (#125); deleting from the
  trash asks first (#132); history is in newest-activity order (#151); the
  Markdown download names models and lists artifacts once (#152); Summarise is
  not offered when there is nothing to summarise (#153); small tables and code
  stay in the reply instead of becoming documents (#149); Export as
  Spreadsheet needs a real table (#150); links in messages are links (#174);
  upload refusals name file types in words (#180).
- **Administration:** report and retry times in the future read "in 30d"
  (#126); every admin form names the field a save failed on (#127, #129,
  #178); a user's page gives the true number of sessions (#134); one role
  change, one audit entry (#140); the storage-allowance API follows the role
  in its URL (#141); the instance upload limit is capped at 1 GiB (#142);
  webhook Send test records the delivery (#144); bulk actions count and
  confirm correctly (#145); audit entries record what changed (#148); dates
  share one format (#177); and fixes to model rename, storage allowance,
  reranking, the policies page on phones, the users table, button names and
  wording (#146, #147, #157, #168, #170, #175, #182).
- **Accessibility and layout:** a visible focus ring in menus and lists
  (#135); focus returns to the opener, or the next row when the opener is gone
  (#128); the page behind a modal menu or dialog is inert (#172); code colours
  meet AA (#171); Settings and sign-in have a main landmark and Settings a skip
  link (#173); the top bars no longer cover the conversation (#166); the
  announcement no longer shifts the page (#167); one layout for every "not
  found" state (#131); tooltips on truncated text (#130); and fixes to the
  model picker on phones, loading states, the full-screen table, the share
  dialog, the command palette, SearXNG errors, attachment wording and
  restricted roles (#143, #155, #156, #158, #169, #176, #179, #181).

## [0.11.0] - 2026-10-05

v0.11 "always on": upgrade from the previous minor release with no downtime,
keep working through a database or Redis failover, and rebuild search
without a gap, each tested in CI. Upgrade with `migrate`, then replace
replicas one at a time, then `migrate --post` (see Upgrading below).

### Added

- **Three-phase migrations.** Pre-deploy migrations stay transactional and
  fast; post-deploy steps (`migrate --post`, after every replica runs the new
  release) build indexes concurrently and rebuild any left invalid;
  background migrations backfill in throttled batches under a lease, each
  batch and its cursor in one transaction, with progress, pause and resume on
  System health → Background work. A release can require earlier work to be
  finished and the migrator refuses, naming it. Migration `0039`.
- **Upgrade preflight.** `pnpm upgrade:check` (or
  `node dist/scripts/upgrade-check.js` in the API image) and System health →
  Upgrades list each pending step with the tables it touches, their sizes and
  index estimates, and answer rolling, needs a window, or blocked.
- **Lock-safe migrations.** Every migration attempt runs with a 3 s lock
  timeout and retries with backoff, so a migration waiting behind a long
  query no longer freezes requests queued behind it; the final error names
  the blocking session. `MIGRATION_LOCK_TIMEOUT_MS`,
  `MIGRATION_STATEMENT_TIMEOUT_MS`.
- **Draining on shutdown.** A stopping replica reports not ready, refuses new
  turns with `503` and `Retry-After` before storing anything (the web app
  retries), lets replies in progress finish for up to
  `SHUTDOWN_DRAIN_TIMEOUT_MS` (25 s) and saves anything left as interrupted.
  A reply whose replica died is recovered within about 20 s instead of
  staying "streaming". The bundled proxy takes a draining or dead replica out
  at once.
- **Worker role.** `OCI_ROLE=web|worker|all` (default `all`): background jobs
  can run on separate worker replicas; System health warns when no worker is
  running. An optional `worker` Compose profile.
- **Failover safety.** Read requests are retried once after a dropped database
  connection; writes answer `500` with `retryable: true`; saving a new
  message and a reply's final save are retried; a job that loses its lock
  stops after its batch. A weekly drill fails over a three-node Patroni
  cluster under load.
- **Connection pooling.** The application pool works behind PgBouncer in
  transaction mode; locks, `LISTEN`, post-deploy steps and backups use
  control connections (`CONTROL_DATABASE_URL`). `READ_DATABASE_URL` serves
  the admin overview and usage reads from a replica within 1 s of the primary.
- **Redis Sentinel and Cluster** (`REDIS_SENTINELS`, `REDIS_CLUSTER_NODES`),
  with bounded timeouts and replies that survive a Redis failover.
- **Provider capacity.** Requests per minute, tokens per minute and replies at
  once per provider and per model, shared across replicas. A turn over
  capacity waits in a fair queue ("you're number N", Stop) instead of
  failing; provider 429 and 5xx answers are retried before the first output.
- **Embedding generations.** Changing the embeddings model fills a new
  generation in the background while search keeps answering from the current
  one, then switches when it covers every passage; the old one is dropped
  after a day. Progress, cost estimate, Switch now and Cancel on the
  Embeddings page. Migration `0041`.
- **Usage rollups.** Usage pages, reports and budget checks read hourly
  totals, exactly equal to the events; the history is backfilled by a
  background migration, with the events used until it finishes. Migration
  `0040`.
- **Read-only maintenance mode** from System health, on a schedule, or with
  `OCI_READ_ONLY=true`: reading, search, export and sign-in keep working;
  writes are refused with `423` and a banner explains why and until when.
- **Settings changes reach every replica at once** over Redis (30 s at most
  without it).
- **Encryption key rotation.** `ENCRYPTION_KEYS_PREVIOUS` decrypts alongside a
  new `ENCRYPTION_KEY`, background migrations re-encrypt every secret, and
  System health counts values still needing an old key.
- **Long conversations load in parts**: the latest messages first, earlier
  ones as you scroll up, and only what is near the screen is drawn.
- **Helm chart** (`deploy/helm/open-chat-interface`, also published to
  `oci://ghcr.io/ncecere/charts`) with migration hooks, draining, disruption
  budgets and Pod Security "restricted".
- **Images for linux/arm64** alongside linux/amd64.
- **Service objectives and alerts**: published objectives, 47 Prometheus rules
  (burn-rate and operational) and a Grafana dashboard in `deploy/monitoring`.
- **Test tools**: a scale harness (`tools/scale`), a rolling-upgrade test under
  load (`tools/upgrade-test`), a failover drill (`tools/failover-drill`) and a
  migration linter (`pnpm lint:migrations`), all in CI.

### Changed

- **Faster at size** (scale harness, 6,000 people and 4 million messages):
  admin Usage spend 777 to 39 ms, the Usage overview 606 to 94 ms, the admin
  overview 126 to 22 ms (at 500,000 messages), and the passage search for a
  large project 773 to 180 ms (p95, 1,000 people).
- **Sign-in limits are OCI's own and shared across replicas**: per account
  (failed sign-ins), per address (generous, for a campus behind one NAT), per
  identity provider, and a per-address ceiling. Better Auth's own
  per-replica limit is off. `RATE_LIMIT_AUTH_PER_MINUTE` now counts failed
  sign-ins per account; new `RATE_LIMIT_AUTH_ADDRESS_PER_MINUTE` and
  `RATE_LIMIT_AUTH_SSO_PROVIDER_PER_MINUTE`.
- **Role changes, bans and revoked sessions apply on the next request**
  (Better Auth's session cookie cache is off).
- **Web search and connector sources are steps in the reply's work block**,
  so every reply has at most one disclosure above its answer.
- **Redis is required for more than one replica**; System health shows an
  error without it.
- **The web container drops every capability** (file capabilities removed
  from Caddy).
- `503` from the API now means only "this replica is draining"; a failed
  stream resume answers `500`.

### Fixed

- **A busy replica could stop admitting turns** while the usage rollup
  backfill ran (introduced and fixed during v0.11 development).
- **postgres.js crash on failover**: a terminated transaction no longer throws
  an uncaught error or strands the pool (patch extended;
  porsager/postgres#1154).
- Conversation search (`/api/threads/search`) was labelled `/api/threads/:id`
  in metrics.

### Upgrading

From v0.10.x, with no downtime:

1. Back up the database. Run `pnpm upgrade:check` against it (or the API
   image's `upgrade-check.js`) to see the work and the verdict.
2. Run the v0.11 `migrate` job (migrations `0039` to `0041`, all fast).
3. Replace API replicas one at a time (v0.10 replicas keep working on the new
   schema), then the web containers.
4. Run `migrate --post`: post-deploy steps `0001` to `0006` build indexes
   concurrently and schedule the usage rollup backfill and secret
   re-encryption.

After step 4 secrets are written in a new format that v0.10 cannot read:
rolling back to v0.10 from then on needs the pre-upgrade backup. A single
instance that migrates itself at startup runs step 4 on its own. The Helm
chart runs steps 2 and 4 as hooks. See docs/OPERATIONS.md, "Upgrade".

## [0.10.2] - 2026-10-03

### Fixed

- **One send starts one conversation.** On v0.10.1, sending from the new-chat
  page could start another conversation for every key press that arrived
  before the page had moved to the new one, which once left thousands of empty
  conversations. A second start is now blocked while one is under way, Send is
  disabled meanwhile, and holding Enter sends once.
- **"New chat with query" in the command palette** now sends its query; it
  used to leave an empty conversation instead.

### Added

- **A limit on starting conversations.** Each person can start as many
  conversations a minute as their role's messages per minute, and an eleventh
  unused conversation within a minute is refused. Both answer 429 with
  Retry-After.
- **Unused conversations are cleaned up.** An hourly job deletes conversations
  that are still untitled, have no messages and have not been touched for a
  day. Pinned, archived, imported and temporary conversations are left alone,
  as is everything belonging to someone on legal hold. Each deletion is
  recorded in the audit log as `unused_expiry`.

## [0.10.1] - 2026-10-03

### Changed

- **One block for the model's work.** A reply that reasoned and used tools in
  several steps showed a "Reasoning" disclosure for each step around its tool
  steps. Everything the model did before its answer now sits in one
  disclosure, in order, summarised as for example "Thought · created an
  artifact" or "Thought · searched the web twice"; while the reply is written
  its header names the current step ("Thinking…", "Writing *title*…").
  Artifact cards and anything waiting for your approval stay visible below it.
  Replies with a single reasoning step look as before.
- **Artifact details open inside the card,** from a chevron at its edge,
  instead of a separate Details link beside it.

## [0.10.0] - 2026-10-03

### Added

- **Delete user** in People → a person: typing their email confirms. The
  server refuses deleting yourself, the last administrator and a person on
  legal hold; deleting a missing account returns not found instead of
  succeeding. The audit entry records the deleted email and role.
- **Rename a conversation** from the sidebar or the conversation's top bar.
- **Context window and output limit per model** in Providers & Models; an
  output limit that leaves no room for input is refused.
- **Backups copy attachment files.** Each backup copies attachment files,
  thumbnails and the uploaded logo to `objects/<sha256>` at the destination,
  once per distinct content, streamed and checked against their checksum; a
  sample (or every file) is read back each run, and copies no kept backup
  lists are removed after retention. On for new backup configurations;
  existing ones keep listing files only until an administrator turns copying
  on (the first copy can be as large as all attachment storage).
  `restore-backup-files` copies them back. Migration `0035_backup_files`.
- **Deletions in the compliance export.** Every deletion (conversations,
  messages, attachments, artifacts, memory notes, projects, accounts, and
  those made by retention) writes an audit entry in the same transaction with
  a `metadata.deletion` block (type, id, owner, reason, whether permanent,
  counts), never the deleted content, so the exactly-once audit export
  carries them.
- **Settings → Sharing** lists every share link you made, with Revoke and
  Revoke all, also after sharing has been turned off for your role. Revoking
  is audited.
- **A default model and reasoning level** in Settings → Models, stored with
  your account so they follow you to any device. A conversation's own choice
  still comes first; a default your role no longer allows falls back to the
  instance default with a note.
- **Delete your own account,** when an administrator turns on "Delete own
  account" for your role in Roles & access (off for every role by default):
  typed confirmation, your password for password accounts; refused under
  legal hold, for the last administrator and in a session an administrator
  opened as you. Migration `0036_personal_defaults`.
- **A fallback web search provider.** After a timeout, network error or
  server error (retried once), search uses the fallback provider when one is
  set; results say which provider answered, and Test search checks both.
- **Which passages a reply used.** The project-search note lists the
  passages (their first ~200 characters, with headings where the file has
  them), and a **Files** control in the composer leaves chosen project files
  out of the next message.
- **Resize the artifact panel** by dragging its edge or with the keyboard;
  the width is kept in this browser.
- **A failed summary you asked for is reported** with the reason (allowance,
  model error, nothing to summarise, timeout), and Retry. Migration
  `0037_compaction_failure`.
- **PDF export in every script.** Documents outside Western European
  characters embed Noto fonts chosen per run of text: Chinese, Japanese,
  Korean, Arabic and Hebrew (shaped, right to left), Greek and Cyrillic.
  Emoji print as a replacement character.

### Changed

- **Branding applies everywhere.** The OCI logo is the default mark beside
  your instance's name (an uploaded logo still replaces it); the browser tab
  shows the page and your instance's name and its icon; share pages follow
  branding; verification and password-reset emails name your instance;
  diagrams use the chosen colour theme's accent (neutral keeps the default
  orange); exports name your instance.
- **Usage is kept after an account is deleted.** Deleting an account, by an
  administrator or by the person, keeps its usage events, daily totals and
  refusal counts with the link to the person removed (no name, email or role
  is kept), so instance-wide reports and budget history stay accurate; Usage
  shows them as **Deleted accounts**. Pending reservations, limit overrides
  and the storage counter are still deleted. Migration
  `0038_usage_kept_after_deletion` scans and rewrites no table. Usage of
  accounts deleted before the upgrade is already gone.
- **Project-search notes keep short excerpts.** To show which passages a
  reply used, the note now stores up to 24 passage starts with the reply.
  Share links never show the note.
- **A reload during a very long reply resumes** from a saved copy when the
  stored stream no longer reaches its start.
- **Backups and Compliance** share their destination, schedule and run
  history controls.
- **Legal hold covers every deletion.** Deleting a held person's project or
  project file is refused; usage-event and share-link pruning skip held
  people; held people cannot delete memories; expired temporary chats are not
  deleted when opened under hold; accounts are deleted only through the
  checked, audited route.

### Fixed

- The keyboard shortcuts Settings lists now work: Cmd/Ctrl+Shift+O (new chat),
  Cmd/Ctrl+B (sidebar) and Cmd/Ctrl+/ (model picker), also while typing.
- An empty optional environment variable counts as unset, so leaving
  `INITIAL_ADMIN_PASSWORD` empty prints a one-time password as documented;
  `AUTH_SECRET`, `ENCRYPTION_KEY` and `DATABASE_URL` still refuse empty values.
- The sharing guide describes live and snapshot links and expiry.
- Expanded projects in the sidebar stay in step across open tabs.
- Revoking a single share link was not audited.
- `RATE_LIMIT_AUTH_PER_MINUTE` had no effect. Sign-in, sign-up, password
  reset and verification are now limited per client address and per email,
  answer 429 with `Retry-After`, and the first refusal each minute is audited.

## [0.9.2] - 2026-10-03

### Security

- **Client addresses could be spoofed.** The web container's Caddy passed
  `CF-Connecting-IP` and `X-Real-IP` from the browser through to the API, and
  the API trusted `CF-Connecting-IP` first, so any client could choose the
  address recorded in the audit log and on sessions, and the address limits
  were counted against. Caddy now sends the API exactly one address and drops
  those headers; the API trusts only that one, validated as an IP. Behind a
  load balancer, another proxy or a Kubernetes ingress, set the new
  `TRUSTED_PROXIES` on the web container so the real client address is read
  from it (docs/OPERATIONS.md, "Behind another proxy or an ingress").
  Deployments with their own reverse proxy in front of the API should make
  sure it sets `X-Forwarded-For` itself rather than passing on what the client
  sent.

### Fixed

- The bundled Compose file passed unset optional variables (such as
  `INITIAL_ADMIN_PASSWORD`) as empty strings; it now leaves them out.
- CI gives the application checks 45 minutes. The v0.9.1 release could not be
  published because validation outgrew the 25-minute limit; v0.9.1 has no
  published images, so upgrade to v0.9.2.

## [0.9.1] - 2026-10-03

### Changed

- **Project conversations live under their project in the sidebar.**
  Projects is a plain heading; each project expands to its five most recent
  conversations, with **Show all (N)** opening the project's Conversations
  tab. Projects start collapsed, your choice is remembered in this browser,
  and the project of the open conversation opens while you are in it. The
  Today, Yesterday and Older lists show conversations outside projects;
  pinned conversations stay in Pinned. `GET /api/projects/sidebar` and
  `GET /api/threads?view=sidebar` serve the new layout; no migration.
- **Settings has seven sections on one row.** Shortcuts and Contact Us are
  no longer tabs: every settings page shows a Keyboard Shortcuts card with
  every shortcut and a Need help? card, and the old addresses redirect to
  Settings. Where the tabs do not fit, a Settings section menu replaces them
  instead of wrapping onto a second row.

- **Settings → Account works.** **Change password** appears when you can
  use a password (email and password sign-in is on, or you are a verified
  administrator) and the server refuses it otherwise. **Devices** lists where
  you are signed in and signs out one device or all others. Password accounts
  can edit their name; single sign-on accounts show that the name, email and
  password come from the organisation. Password changes, name changes and
  device sign-outs are audited.
- **Settings → Customization:** **Invert Send/New Line Behavior** now works
  (Enter adds a line, Cmd/Ctrl+Enter sends) and is kept in this browser;
  **Appearance** chooses Light, Dark or System, and the settings header uses
  the same menu as the chat. **Save Preferences** is available only when
  something changed.
- **Settings → History** (renamed from History & Sync): search by title,
  **Load more** beyond the first 200 conversations, titles open the
  conversation, **Select all**, project labels, and **Export** and **Import**
  as buttons at the top.
- **Settings → Attachments** lists project files (with a link to their
  project) and splits storage into chat files, project files and artifacts,
  so the totals match.
- The Memory and Connectors tabs are hidden when there is nothing in them;
  their addresses still work.

### Removed

- **Change Email** and **Delete Account** in Settings, which never worked.
  Email addresses come from sign-in, and administrators delete accounts under
  People → Users. Self-service deletion, behind an administrator setting, is
  planned for v0.10.
- **Hide Personal Information** in Settings → Customization, which was never
  saved or applied.

### Fixed

- Settings on a phone squeezed the page beside a desktop-width profile column;
  narrow screens now show the profile, the page and the cards one above the
  other.
- Settings marked Account as the current section on every settings page.
- The password-change audit entry recorded no actor unless other devices
  were signed out at the same time.
- The message editor's keyboard shortcuts ignore keys pressed while an input
  method (IME) is composing text, as the composer already did.

## [0.9.0] - 2026-10-03

### Added

- **Long conversations are summarised in the background instead of cut
  off.** After a reply, a conversation past 75% of the model's input budget
  has its older turns summarised by the conversation's own model into a
  structured summary (topic, facts and decisions, preferences, open
  questions, critical details) while recent turns are kept verbatim, after
  the approach of the [pi coding agent](https://pi.dev). Summaries are made
  by the job runner, never while a reply waits: sending, retrying, switching
  replies and approving never wait for one or are refused because of one.
  Requests survive restarts and run once per conversation across replicas.
  Later summaries build on the previous one, and cuts fall only between user
  turns. **Summarise earlier messages now** asks for one, with optional
  instructions, and returns at once. A provider context-length error retries
  once with fewer earlier turns. Nothing is deleted: a quiet line marks where
  messages were summarised and expands to the summary, and exports, search
  and share links keep the full history. Each summary is a usage event.
  General settings has an on/off switch for automatic summaries (on by
  default). Migration `0028_conversation_compaction`.
- **Meaning-based search for project files.** With an embeddings model
  configured under **Providers & Models → Embeddings** and the pgvector
  extension enabled by the operator, project search merges keyword and vector
  rankings, so paraphrases are found while exact names and codes still match.
  Without either, search stays keyword-only as in v0.8. Passages are embedded
  on upload and by a background job; embedding calls are usage events. OCI
  never creates the extension. Migration `0029_embeddings`.
- **Optional reranking** of project-file passages through any
  Cohere-compatible `/rerank` endpoint (LiteLLM, vLLM, Jina, Cohere), with or
  without pgvector. A failure or timeout keeps the previous order.
- **Artifacts.** HTML pages, SVG images, Mermaid diagrams and documents from
  replies are kept as versioned artifacts, and tool-capable models can create
  and revise them (`create_artifact`, `update_artifact`). They open in a side
  panel with preview, source, versions, copy and download; Markdown documents
  can be edited directly. HTML and SVG run in a sandboxed frame with an opaque
  origin and no network access, also on share links. The frame page writes
  nothing unless it is sandboxed, so it stays safe behind a proxy that sends
  no policy for it; operators with their own proxy should still send the
  documented headers for `/artifact-frame.html`. Per-role switch, a
  General settings switch for Diagram Design guidance (MIT, Cathryn Lavery),
  storage accounting, export and forks. Migration `0032_artifacts`.
  - **Written live.** While a model writes an artifact, the reply shows a
    card with its title, line count and latest lines, and revisions show
    their changes. On wide screens the panel opens beside the conversation
    by itself for replies written in that tab, shows the source as it
    arrives and switches to the preview when it is saved, without moving
    focus; on phones the card shows progress and opens the panel when
    tapped. Settings → Customization → **Open artifacts automatically**
    (on by default).
  - **Full screen** from the panel header, also on phones and share links.
  - **Readable steps.** Expanding an artifact step shows its title, kind,
    size and each change as before-and-after text instead of the tool's
    JSON input.
  - Source views are syntax-highlighted like code blocks in chat.
  - Models are asked to keep program code in the reply as code blocks, use
    Markdown artifacts only for long documents the person asked for, and
    not link to artifacts.
- **Export as DOCX, PDF, XLSX or PPTX** from replies and Markdown artifacts,
  generated server-side in a worker thread. XLSX takes the reply's tables;
  PPTX makes a slide per heading; PDFs cover Western European characters.
  Owner only, size- and rate-limited, audited without content.
- **User memory**, opt-in at three levels: the instance (off by default), the
  role and each person (Settings → Memory). Tool-capable models get `remember`
  and `forget`, never in temporary chats, and the reply shows "Memory updated"
  with Undo. Notes join the system prompt within a budget, are exported, can
  expire through a retention setting, and are audited without their text.
  Migration `0033_user_memory`.
- **Compliance export and legal hold.** Audit events, and optionally
  conversation content, are exported on a schedule as verified JSON Lines
  objects to S3, exactly once per event across restarts. Legal holds keep a
  named person's data: retention, trash purging, temporary-chat expiry, audit
  pruning and memory retention skip them, and their account cannot be deleted
  by any path. Data & storage → Compliance. Migration `0034_compliance`.
- **Automated backups.** Scheduled `pg_dump` streamed to S3, verified by
  reading it back (`pg_restore --list` and checksums), with daily and weekly
  retention and a manifest of attachment objects. Data & storage → Backups.
  The API image now includes the PostgreSQL client tools.
- **Observability and webhooks.** A Prometheus `/metrics` endpoint, served
  only when `METRICS_TOKEN` is set; OpenTelemetry traces when
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set (no content in spans); signed
  (HMAC-SHA256), retried webhooks for audit events under Tools & integrations
  → Webhooks. Migration `0030_backups_webhooks`.
- **A composer hint** to connect an account when a connector's tools are
  allowed but the person has not connected.
- **A live reasoning preview.** While a model thinks, a three-line window
  under "Thinking…" shows its latest reasoning; it collapses to "Reasoning"
  when the answer starts, and expanding it shows everything.

### Changed

- **A timed-out web search is retried once** within the tool's time limit.
- **Connector token refresh is coordinated across API replicas**, so a
  rotating refresh token is used once and every caller gets the new token.
- **Replies show their parts in the order they were written** (reasoning,
  tool steps, text), also on share links and in Markdown exports, instead of
  every tool step first.
- In your own conversations, a link the safety rules refuse shows as its
  text instead of "[blocked]"; share links keep the marker.
- The message box's focus line is drawn inside its border.
- **Project search adds only relevant passages.** Keyword matches on common
  words no longer count on their own, and passages far weaker than the best
  match are left out, so a question the project's files do not cover adds
  none (and shows no note) instead of filling the context with unrelated
  sections. Meaning-based search and reranking have floors of their own. The
  opening sections of every file are no longer sent when nothing matches.

### Fixed

- Scrolling past the end of a conversation could scroll the whole page and
  carry the message box off screen (hidden screen-reader text escaped the
  conversation's scroll area).
- The Stop and Send icons were invisible on the neutral colour theme.
- Highlighted code followed the operating system's light or dark setting
  instead of OCI's theme, which made it hard to read when they differed.
- Starting a conversation from the home page dropped the cursor out of the
  message box.
- The first message of a conversation, and a just-sent question moved to
  the top, could sit under the top bar's buttons on phones and narrower
  windows.
- A webhook delivery or storage deletion queued in the same millisecond as
  the job that looked for it waited for the next run (PostgreSQL keeps
  microseconds, JavaScript milliseconds).

### Removed

- **`user_preference.boring_mode`**, unused since v0.8 (migration
  `0031_drop_boring_mode`).

### Known limitations

Planned for v0.10 (see `ROADMAP.md`):

- Legal hold does not yet pause project file deletion or usage-event pruning,
  and deletions are not exported as compliance events.
- Backups list attachment objects in a manifest rather than copying them; use
  bucket versioning or volume snapshots for attachment data.
- Exported PDFs cover Latin scripts only.
- The artifact panel cannot be resized, and reloading during a very long
  artifact may not resume its stream.
- A summary someone asked for that fails in the background is not reported.

## [0.8.0] - 2026-10-02

Tools and connected knowledge: tool calling with per-role switches, approval
and audit; web search as a tool, with SerpApi and SearchApi providers; search
over large project files; and MCP connectors with per-person OAuth. Migrations
0026 and 0027 only add new tables; existing project files are indexed by a
background job after the upgrade. Deploy the API and web images as a pair.

### Added

- **Tool calling.** Models tagged `tool_calling` in the catalog can call
  tools during a reply when the instance and the person's role allow them.
  Roles & access has a **Tools** section with a switch per tool and role
  (`PUT /api/admin/roles/:role/tools`, audited as `role.tools.update`): built-in
  read tools are on for every role except `restricted`, connector tools are off
  until allowed. A reply spends at most **8** steps using tools by default (General
  settings, 1–20); a reply that reaches it gets one final step with the tools
  withdrawn, so it still answers with what it found, and a note says so. A
  reply also stops when the person's allowance runs out between steps. A tool
  call with invalid input is answered with which fields were wrong, so the
  model can correct it. Tools that change something elsewhere ask
  for approval: the reply waits with **Approve** and **Deny**, and answering
  (`POST /api/chat/:threadId/approvals`) continues the same reply. Sending a
  new message instead denies open approvals as "not answered". Each call is
  audited as `tool.call` with metadata only, never inputs or results. Tool
  steps appear in the reply as collapsible lines; share links and both exports
  show one-line summaries without raw results. Models without tool calling
  behave exactly as before. See `docs/user/tools.md` and
  `docs/dev/tools-design.md`.
- **SerpApi and SearchApi as web search providers** (Google results, SafeSearch
  on), alongside SearXNG, Tavily, Brave Search and Exa. SearchApi's key is sent
  in a header rather than the URL.
- **Test search** on the Web search page runs one sample search with the
  provider and key or address on the page, saved or not, and shows whether it
  worked or what the provider replied. Audited as `search.test`.
- **Web search as a tool.** With a tool-capable model and **Search** on, the
  model decides when and what to search, may search more than once (up to 10
  results each) and cites results as sources. Other models keep the single
  search before the reply. Providers and switches are unchanged.
- **Large project files are searched instead of left out.** Project files are
  split into indexed passages. When a project's files do not fit the context,
  each message includes the passages that best match it, labelled with file
  name and passage number, and the reply notes that project files were
  searched. Small projects are still included whole. The project page shows
  whether each file is searchable. Migration `0026_project_file_chunks`; the
  `projects.index-files` job indexes existing project files after the upgrade.
- **MCP connectors.** Administrators add remote MCP servers (Streamable HTTP)
  under **Connectors**, with no authentication, a shared credential stored
  encrypted, or OAuth per person; test the connection; refresh the server's
  tools; and enable individual tools as read or write (a tool counts as read
  only when the server marks it read-only, unless an administrator confirms
  otherwise). People connect their own accounts under **Settings →
  Connectors**, so the connected system applies their own permissions.
  Connector tools join the tool registry, so role switches, approval for write
  tools and audit apply; links in results become sources. Outbound requests
  are HTTPS only, refuse private, loopback, link-local and cloud-metadata
  addresses unless "Allow private network" is set (metadata addresses always),
  follow no redirects, and are limited to 30 seconds and 2 MB. All
  administrator and connect/disconnect actions are audited. System health
  shows connector status. Migration `0027_connectors`. New dependency:
  `@ai-sdk/mcp` (Apache-2.0).

### Changed

- **The project page uses tabs.** Conversations, Instructions, Files and
  Settings (rename and delete) are pill tabs, laid out like the user settings
  pages instead of cards. The page opens on Conversations, and the open tab is
  kept in the address (`?tab=`).

- **A failed web search no longer fails the reply.** When the search before a
  reply fails, the reply goes ahead: the model is told the search failed and
  asked to say that current sources could not be checked, and the reply shows
  **Web search failed** with the reason. Search provider errors now name the
  provider and the cause, for example "SerpApi rejected the web search API key
  (HTTP 401)", and are logged without the query or key.
- **The Web search page asks for exactly what the chosen provider needs:** an
  API key for hosted providers (labelled with that provider and where to find
  it) or the address of a SearXNG instance, and requires it before search can
  be switched on. It no longer offers a base URL that hosted providers ignored,
  or an optional credential to SearXNG.

### Fixed

- **The audit log recorded a cleared secret as set.** Settings snapshots were
  redacted twice, and the second pass read the `[unset]` marker as a value, so
  a change's "before" could show a key as `[set]` when none was stored.
- **Chat errors are shown as text.** A failed request showed the server's raw
  JSON (`{"error":{"code":…}}`) above the composer; it now shows the message.

- **Switching web search provider no longer keeps the previous provider's
  key.** The key was sent to the newly selected provider; the server now
  removes it on a switch and stores only what the selected provider uses.

- **A reply stopped part-way through recorded no token usage.** It now
  records the usage of the steps that finished, still marked as incomplete.

### Removed

- **Boring mode** (theme menu and Settings → Customization). It only replaced
  an instance colour theme's accent with the neutral one, which is already the
  default, so it looked like it did nothing. The unused
  `user_preference.boring_mode` column is left in place for this release so
  that API replicas still on v0.7 keep working during a rolling upgrade; it
  will be dropped in the next one.

## [0.7.0] - 2026-10-01

Organise and find: per-role feature switches, full-text search, projects,
Mermaid diagrams, a switcher for retried replies, and full export plus import
from ChatGPT and Claude. Migrations 0022–0025 run on upgrade; 0023 builds a
search index that blocks writes to `message` while it builds on a large
instance (see the v0.7 upgrade notes in `docs/OPERATIONS.md`). Deploy the API
and web images as a pair.

### Added

- **Feature entitlements per role.** On Roles & access each role has switches
  for web search, file attachments, share links, temporary chats and branching,
  and a choice of allowed reasoning levels (Instant is always allowed). A
  feature is available only when both the instance-wide switch and the role's
  allow it; the server enforces each one, including web search on a chat turn
  and reasoning levels in `/models` and chat validation. Saved through
  `PUT /api/admin/roles/:role` (changed fields only, audited as
  `role.features.update`, read-only for auditors). Defaults match the previous
  fixed rules, so restricted accounts still cannot upload, share or start
  temporary chats until an administrator changes it. Refusals now read "…is
  not available for your role". No database migration.
- **Default reasoning level** on General settings (`defaultEffort` in
  `PATCH /api/admin/settings`, exposed to clients in `/api/me`). New
  conversations start at it, clamped to what the selected model and the
  person's role allow, falling back to Instant.
- **Full-text conversation search.** The sidebar search and the command palette
  now search message text as well as titles, with prefix matching (every word
  must appear), best match first and up to three highlighted lines per
  conversation. Only `text` parts are searched — not reasoning, sources or
  attachment contents. Archived conversations are included and flagged;
  trashed and temporary ones are not. Choosing a result opens the
  conversation at the matching message (`/chat/:id?message=:messageId`),
  centred, briefly highlighted (a still outline under reduced motion) and
  focused, instead of at the end. New `GET /api/threads/search?q=&limit=`
  (default 20, at most 50) returns thread summaries, a rank, a marked title
  and `{messageId, role, snippet}` matches; matches are marked with the
  control characters U+0001/U+0002, never HTML. `GET /api/threads?search=`
  (title substring) is unchanged. Migration `0023_message_text_search` adds a
  GIN index on message text; on a large instance it takes time to build and
  blocks writes to `message` while it does — see the upgrade notes in
  `docs/OPERATIONS.md`.
- **Projects.** Group conversations under shared instructions and files. The
  sidebar has a Projects section; each project has a page (`/projects/:id`)
  with its name, instructions (up to 8,000 characters), files (up to 20) and
  conversations, and **New chat in project**. **Move to project** (top right
  of a conversation) moves a conversation in or out. Project instructions are
  added to the system prompt after the instance prompt and the person's
  personalisation, clearly delimited; project files' extracted text joins the
  context through the attachment path and context budget, ahead of older
  history, and a file that does not fit is left out rather than truncated
  (the reply is marked context-limited). Nothing from a project is stored in
  the conversation or exposed through share links. Project files are
  attachments (`attachment.project_id`), so validation, extraction, storage
  drivers and the storage allowance apply; removing one or deleting its
  project deletes it at once and frees its storage. Deleting a project keeps
  its conversations and detaches them. A per-role **Projects** switch on Roles
  & access (off for `restricted` by default; no instance-wide switch) gates
  every project request with `403`; when off, existing projects are kept but
  contribute nothing to conversations. API: `GET/POST /api/projects`,
  `GET/PATCH/DELETE /api/projects/:id`, `GET/POST /api/projects/:id/files`,
  `DELETE /api/projects/:id/files/:fileId`, `projectId` on
  `POST /api/threads`, `PATCH /api/threads/:id` and
  `GET /api/threads?projectId=`, and `projectId` in thread summaries. Limits:
  100 projects per person. The full export includes projects (manifest entry
  plus files under `projects/<name>/`). Migration `0024_projects` adds the
  `project` table and nullable `thread.project_id` (ON DELETE SET NULL) and
  `attachment.project_id` (ON DELETE CASCADE).
- **Mermaid diagrams.** ```` ```mermaid ```` blocks render as diagrams in
  conversations and on public share pages, in an editorial style after
  [Diagram Design](https://github.com/cathrynlavery/diagram-design) (MIT):
  flat shapes, hairline strokes, monospace edge labels, and the instance
  accent reserved for a node marked `:::focus`. Diagrams follow the light or
  dark theme. Mermaid loads only when the first diagram appears and runs with
  strict security (no HTML labels, click handlers or scripts). New dependency:
  `mermaid` (MIT).
- **Wrap long code lines** (Settings → Customization), saved in the browser.
- **Switch between retried replies.** Retrying keeps the earlier replies to
  that question; on the latest reply, **Previous reply** / **Next reply**
  ("‹ 2 / 3 ›", announced as "Reply 2 of 3") switch between them. The chosen
  reply is the one shown after a reload and the one the model, exports
  (single conversation and full export), share links and search see; the
  others are kept but left out. Switching is available only on the latest
  turn and not while a reply is generating; editing an earlier message still
  starts a new conversation. Like Retry, it needs no branching permission.
  Retry is now refused (`422`) for any question but the latest. API:
  `PATCH /api/threads/:id/messages/:messageId/active` (owner only; `404` for
  other people's threads, `409` while a reply is generating, `422` for a
  reply to an earlier turn), and `GET /api/chat/:threadId/messages` returns
  `replies`, every reply to the latest turn when there is more than one.
  Usage and quotas still count every reply generated. Forks and edits copy
  only the chosen replies. Migration `0025_reply_alternates` adds nullable
  `message.superseded_at` and marks all but the newest reply to each turn as
  replaced, matching what people saw after retrying.
- **Export everything and import from ChatGPT or Claude** (Settings → History →
  Your data). `GET /api/me/export` streams a ZIP of every active and archived
  conversation (Markdown plus a complete JSON record with reasoning), the
  person's attached files, `manifest.json` and `README.txt`; trashed and
  temporary chats are excluded. One export at a time per person, audited as
  `user.export`. `POST /api/me/imports` accepts a ChatGPT or Claude export
  `.zip` (including ChatGPT's split 2026 layout and nested Privacy Portal
  archives) or a bare `conversations.json`, up to `IMPORT_MAX_UPLOAD_BYTES`
  (default 512 MB), and processes it in the background (`imports.process`
  job, resumed after restarts). Only the visible branch is imported, with
  titles, timestamps and reasoning; re-importing skips conversations already
  present. Imports are streamed, bounded against zip bombs and unsafe paths,
  do not count towards usage limits, and are audited as `user.import`.
  `GET /api/me/imports` lists them and `DELETE /api/me/imports/:id` cancels or
  removes one. Migration `0022_conversation_imports` adds the
  `conversation_import` table and `thread.import_source`/`import_source_id`.
  New dependencies: `fflate`, `@streamparser/json`, `busboy` (all MIT).

### Fixed

- **A retried reply no longer leaves both answers in the model's context.**
  After a retry, the next question was sent with the original reply and the
  retried one back to back, so the model saw two answers to one question.
  Only the chosen reply is sent now, including for existing conversations
  (see migration `0025_reply_alternates`).
- **Counts that always read 0:** messages per conversation in the Trash,
  dismissals per announcement and acceptances per usage-policy version. The
  queries compared a table's id with itself.
- **`%` and `_` in searches are matched literally** in conversation titles,
  the administrator user list and the audit log, instead of acting as
  wildcards ("50%" no longer matches "500").
- **The generated API reference** (`docs/dev/api-reference.md`) no longer
  lists stream events and header lookups as routes, lists the admin health
  route at `/api/admin/health`, and shows each route's full first sentence.

### Removed

- **The unused Canvas and MCP feature switches.** Neither controlled anything
  or appeared in the interface. Stored values are ignored and disappear the
  next time features are saved. Artifacts and MCP connectors will bring their
  own per-role switches.

## [0.6.1] - 2026-10-01

Providers & Models split into tabs. No database migrations; deploy the API and
web images as a pair.

### Changed

- **Providers & Models** (renamed from Providers & models) has a Providers tab
  and a Models tab, kept in the URL (`?tab=models`), like Roles & access.
  Setup checklist links open the tab that resolves each item.

## [0.6.0] - 2026-10-01

Administration organised around the tasks administrators do, with guided setup,
a single page for role access and actionable user accounts; correctness fixes
found along the way; and chat that keeps up with a streaming reply.

### Added

- **Setup checklist on the admin Overview.** Computed by the server from stored
  configuration — provider, models, default model, sign-in method, email
  delivery (required when verification or scheduled reports depend on it),
  attachment storage, web search, acceptable use and Redis — with a link to
  the page that resolves each item. Nothing in it contacts an external service.
- **Roles & access page** (`/admin/roles`). Per role: people count (linked to
  the filtered user list), fixed rules, effective features, visible models,
  editable rate limits and storage allowance, and assigned usage budgets; plus
  instance-wide sign-in attempts and reservation amounts. Rate-limit and
  retention values show whether they come from saved settings, an environment
  variable or the built-in default.
- **User account page actions.** Change role (confirmation when granting or
  removing administrator access), ban and unban, sign out everywhere, and a
  Limits section showing each budget's usage and reset time, storage against
  the role's allowance, per-person adjustments and a link to role settings. The
  user list has a role selector on each row.

### Changed

- **Administration is grouped by task**: People, Models, Sign-in & security,
  Data & storage, Insights, and Appearance & features. Merged pages keep their
  old addresses as redirects: `/admin/providers` to Providers & models,
  `/admin/sso` to the single sign-on section of Authentication,
  `/admin/rate-limits` and `/admin/storage-limits` to Roles & access,
  `/admin/maintenance` to System health, and `/admin/settings` to General.
- Instance settings are separate pages (General, Authentication, Email delivery).
  The default model is chosen on Providers & models; background jobs and
  storage reconciliation are on System health.
- Web search has a single switch on the Web search page, and clients are
  offered search only when it can run.
- Branding's **Accent color** is now the instance accent preset (neutral, blue,
  violet, emerald), moved from General and replacing the hex colour field.
  **Default theme** now applies to people who have not chosen a theme.
- Auditors can open every admin page read-only, with a banner; controls that
  would change something are hidden or disabled.
- On narrow screens the admin navigation opens in a drawer from a menu button,
  wide tables scroll within the page instead of widening it, and provider rows
  wrap their actions below the details. Admin tab strips follow the standard
  keyboard pattern (arrow keys, Home and End).
- Admin pages report failed saves, confirm destructive actions such as deleting
  a provider or banning in bulk, and offer a retry when a page fails to load.
  The Canvas, MCP and session-refresh controls, which had no effect, are removed.

### Fixed

- **Conversations scroll with what is happening.** A sent question moves to the
  top of the view with room below for the reply, and the view follows a
  streaming reply once it fills the screen. Scrolling up stops following and
  shows **Jump to latest**. Long conversations also open at their end; before,
  they could stop well short of it.
- Banning a single account now ends its sessions immediately, as bulk bans
  already did.
- Concurrent default-model changes are serialised, so exactly one model remains
  the default.
- **Saving one administrative field no longer resets others.** Partial updates
  applied create-time defaults to fields that were not sent: saving any instance
  setting reset the session lifetime to 30 days, toggling or renaming a model
  cleared its default flag, capabilities, reasoning efforts, role visibility and
  order, and pausing a scheduled report reset its window to 30 days. Omitted
  fields now stay unchanged. Re-check those values if they were edited before.
- **Audit-log retention now runs.** The pruning query was rejected by PostgreSQL
  on every run, so audit entries were never removed and the job reported failure.
- Single sign-on providers can be edited to the auditor role, matching creation,
  and a claim mapping to the auditor role now takes effect at sign-in.

### Security

- Role changes and sign-in policy changes are recorded under protected audit
  actions that retention never removes; bulk role, ban and unban are protected
  too. Model discovery against a provider is now audited.

### Upgrade notes

- No new database migrations since 0.5.0. Deploy the API and web images as a
  pair.
- Before this release, saving one administrative field could reset others.
  After upgrading, check session lifetime, each model's visible roles,
  capabilities and default flag, and scheduled report windows.

## [0.5.0] - 2026-10-01

Chat reliability, privacy and accounting under concurrency, with measured startup
improvements and explicit recovery and rollout contracts.

### Fixed

- Reserve a durable response claim before expensive chat preparation. Cache loss
  or age alone no longer permits competing producers to take over a conversation.
- Reserve upload capacity atomically and settle usage transactionally. Ambiguous
  uploads retain capacity; partial usage cannot erase known consumption, and
  unresolved reservation records survive retention until they can be reconciled.
- Keep shared conversations private after deletion, expiry and restore. Restoring
  a conversation does not reactivate its old public links.
- Pin migration ownership to one physical PostgreSQL transaction and check the
  latest required migration before starting with automatic migrations disabled.
  Maintenance locks clean up private connections, including forced shutdown.
- Reconcile interrupted replay against the exact saved response without treating
  a reader disconnect as cancellation. Preserve drafts, accepted attachments and
  canonical prompt identity across interruption, navigation and recovery.
- Reconstruct historical attachments from authorized stored references, bound
  selected conversation context, and include Anthropic thinking within the total
  output budget. Omitted earlier context is visibly indicated; required input
  that exceeds the budget is rejected instead of silently discarded.
- Preserve IME composition without submitting early, and avoid integer overflow
  when aggregating large usage totals.
- Correct administrative user-list thread/message counts: single-table SQL
  projections could bind the owner reference to a child identifier, displaying
  zero or another account's count. Counts now remain correlated to the listed user.

### Security

- SMTP failure no longer waives required email verification; unreadable policy
  fails closed while verified administrators retain the documented recovery path.
  Historical verification flags and sessions are not reset or treated as proof
  of mailbox ownership.
- Update Hono to 4.13.7, Nodemailer to 10.0.9, Undici to 7.29.1 and DOMPurify to
  3.4.16. Registry audits report zero known advisories as of October 1, 2026,
  without suppressions; this is not a container-OS or universal security claim.

### Changed

- Defer administration/settings routes and avoid rerendering unchanged historical
  messages during streaming. The isolated comparison reduced startup JavaScript
  transfer by about 17%; typing was already responsive, and first text was about
  50 ms slower. See the recorded evidence rather than assuming universal wins.
- Separate chat controls, lifecycle, context planning and usage reporting by
  responsibility, with regression coverage for their public behavior.
- GitHub is now the primary repository. GitHub Actions validates changes and
  publishes reviewed stable releases as API/web images on GHCR, with
  version, commit and latest tags. Existing release tags can be published by
  manual dispatch without moving them. GitLab release history remains intact.

### Upgrade and verification notes

- **Migrations 0020 and 0021 are required.** Back up and verify restore readiness,
  drain old producers, apply migrations once, and roll out a verified API/web
  pair. Do not mix old/new producers. Database/schema rollback is not implied by
  retaining old image digests; follow the recovery runbook.
- At the remediation checkpoint, 799 API tests passed on the host and Linux/arm64
  with real PostgreSQL/Redis/SMTP/S3-compatible services, plus 44 production-browser
  cases. PR CI passed linux/amd64 image builds and 793 API cases; only six S3
  cases skipped because CI lacks that service. Those six passed locally. After
  the user-count correction, the release branch passed 803 API tests on Linux
  with real PostgreSQL/Redis/SMTP/S3-compatible services and no skips. Counts
  overlap. The legacy source-built MinIO was an isolated test fixture, not an
  official release or production recommendation.
- No paid-provider, production-load or full accessibility-conformance claim is
  made. Release publication, staging and deployment remain separate gates.

## [0.4.1] - 2026-09-16

Reliability and dependency security fixes, focused internal modules, and complete
user, administrator and developer guides. No new database migrations are required
when upgrading from 0.4.0.

### Fixed

- **Concurrent responses now reserve Redis slots atomically.** Competing requests
  can no longer both observe the last available slot and exceed the configured
  cap. Retrying the same run does not consume another slot. Redis-unavailable
  behaviour remains local/fail-open.
- **Quota policy edits are all-or-nothing.** Model scope is validated before
  mutation, and policy, role and model assignments commit together. Rejected
  edits preserve the previous configuration; concurrent edits are serialized.
- **Administrator-created auditors retain their requested role** instead of
  becoming ordinary users.
- **Failed chat setup cleans up acquired resources.** Database fallback errors,
  quota refusals and SDK setup failures release owned slots and reservations and
  attempt to mark streaming placeholders failed. Once SSE capture starts, it
  alone owns run finalization. Usage settlement is still attempted if saving the
  assistant response fails, without masking the original failure.

### Security

- Updated Hono to 4.13.5, Nodemailer to 9.1.1, transitive xmldom to 0.8.15 and
  Nanoid to 3.3.18. Updated Vitest, its mocker and V8 coverage provider to 4.1.11.
- Production and full dependency audits report zero advisories as of September
  16, 2026, down from 20 production advisory entries. No findings were suppressed;
  this is a scanner result, not a guarantee of zero vulnerabilities.

### Added

- End-to-end user, administrator and developer documentation, with 37 product
  screenshots, a generated API reference, feature-development examples, and a
  fictional demo dataset and separate screenshot-capture harness.
- Regression checks for Redis contention, PostgreSQL rollback and concurrent
  policy edits, auditor creation and chat failure cleanup. Added security-boundary
  assertions for the upgraded test runner without lowering coverage thresholds.
- A repeatable signed-SAML dependency smoke that checks a valid response,
  signature tampering and malformed XML using disposable local keys.

### Changed

- Split oversized chat and administrative workflows into focused service,
  form-state and presentation modules while preserving their existing contracts.
  Removed confirmed dead exports and unused direct dependencies.
- Added an informational structural-audit command and documented maintenance
  boundaries, dependency remediation and verification limits.

### Verification limits

- Combined remediation checks passed with 312 API tests, 120 web tests and 112
  live PostgreSQL/SMTP checks. Existing coverage thresholds were retained.
- Six S3 checks remain unverified because the configured MinIO image could not
  be pulled. A staging/production deployment smoke has not yet been performed.
- The signed-SAML smoke does not replace an external IdP interoperability test.
  Existing SSO/session-control follow-ups and cookie-cache revocation behaviour
  are not changed by this release.

## [0.4.0] - 2026-08-09

Administration at scale: what an administrator can control, what they can find
out afterwards, and whether either holds up at twenty thousand accounts.

### Added

- **A read-only auditor role.** Administration was all or nothing, so a
  compliance reviewer needed write access to do a job that only requires
  reading. An auditor sees every administrative surface and can change none of
  it, enforced on the request method rather than on a hand-kept list of
  endpoints.
- **Authentication events in the audit log.** Sign-in, sign-up, sign-out,
  password reset, email change, verification, and single sign-on now record an
  outcome. Failures are recorded too, including for an account that does not
  exist, which is what makes a brute-force attempt visible. The source address
  is recorded with them; the column existed but had never been populated.
- **A user detail view**, showing counts, storage, active sessions with their
  addresses, recent conversation titles, and the audit trail for that account.
  Conversation titles only: an administrator managing an account has no reason
  to read its contents.
- **An operational health page** covering the database, Redis, providers,
  models, background jobs, email, and attachment storage. Each of these
  previously surfaced as a user complaint rather than as a status.
- **Refusing a sign-in that matches no role.** A provider can now require that
  group membership map to a role, instead of admitting everybody the identity
  provider will authenticate with a default role. Off by default, so an
  upgrade changes nothing until an administrator turns it on.
- **Profile claim mapping and direct sign-on.** Which claims carry email, name,
  picture, and subject is configurable, and a provider can take over the
  sign-in page. The local form stays reachable at `/auth/login?local=1`, which
  is the way back in if the provider fails.
- **Configurable session lifetime**, applied as each session is issued rather
  than read once at startup.
- **Bulk user actions** for roles, bans, and session revocation. An
  administrator cannot include their own account, and a ban revokes sessions in
  the same operation.
- **Saved list views**, held per person, and **scheduled usage reports**
  delivered by email.
- **Audit export and filtering.** Search, action family, and date window are
  applied in the query, with a CSV export. The log previously returned two
  hundred rows and filtered them in the browser, so retained history could not
  be reached.
- **Configuration change history.** A settings entry records what a value was
  as well as what it became. Secrets record only whether they are set.
- Administrative pages are reachable from the command palette, audit entries
  link to the accounts they name, and the overview compares activity with the
  window before it.

### Fixed

- **The user listing did not work at scale.** Counting threads and messages per
  account scanned the whole message table once per row. Measured at twenty
  thousand users and two million messages, the default listing took 2,553 ms
  and sorting by message count did not finish in sixty seconds; both are now
  5 ms and 147 ms. Migration `0017` adds the missing index.
- **Most of the directory was unreachable.** The listing accepted paging
  parameters that the interface never sent and offered no control, so it showed
  the first fifty accounts and nothing else.
- **Role mapping from single sign-on had never matched a real claim.** The
  provisioning hook was reading the OAuth token response rather than the
  identity claims, and the plugin's normalised profile carries only id, email,
  name, and image — so a claim such as `groups` was in neither. Any existing
  mapping could only have matched by accident.
- A refused single sign-on returned an error page indistinguishable from an
  outage, and left an unused session behind.
- Session expiry was displayed as though it had already passed.

### Security

- Refusing an unmatched sign-in makes group mapping an authorisation boundary
  rather than a label. Existing providers are unaffected until it is enabled.
- Settings changes redact secret values recursively, including a secret nested
  inside a configuration branch whose own name does not look like one.

## [0.3.0] - 2026-08-08

Administration and onboarding: what an instance tells people when they arrive,
and how an administrator manages it once they are here.

### Added

- An acceptable use policy that people must accept before using the instance.
  Policies are versioned and never edited in place: an acceptance records
  agreement to specific wording, so publishing a change creates a new version
  and re-prompts everyone automatically. A version somebody accepted cannot be
  deleted, since that would destroy the record of what they agreed to.
- A short introduction for new accounts, collecting a name, occupation, tone,
  and any other context. Everything it asks feeds the system prompt, which is
  the only reason to ask. It can be skipped.
- Instance-wide announcements, shown as a banner rather than a toast so a
  maintenance notice stays readable. Dismissal is per person, and editing an
  announcement does not re-show it to those who have already dismissed it; a
  separate action does that deliberately.
- A logo upload for the sign-in page and sidebar, with a short name as a
  fallback. Uploads are validated by content rather than file extension, and
  SVG is rejected: the logo renders before sign-in, where a scriptable image
  would be stored cross-site scripting.
- An information card for each model in the picker, listing its description,
  features, provider, and limits.
- Sorting and filtering on the user list, applied in the query so it describes
  every account rather than the page already loaded.

### Changed

- Roles for SSO users are recalculated from identity-provider group membership
  on every sign-in. Where a user matches several group mappings, the most
  privileged one now wins rather than whichever mapping happened to be listed
  first: row order is an authoring detail, not a privilege decision. Group
  claims are matched case-insensitively and can be read from nested attributes,
  which SAML and some OIDC providers require.

  **Some users may see their role change on their next sign-in**, in either
  direction — a user matching a more privileged mapping gains it, and one who
  has left a group loses it. Recalculation on every sign-in predates this
  release; what changed is which mapping wins. Note that a role set by hand in
  the admin interface does not survive an SSO user's next sign-in.
- Model capabilities are colour-coded in the picker, each with its own hue and
  a matching label. Colour is a second signal rather than the only one.
- The default model is set in instance settings rather than on individual
  catalogue rows.
- Every dropdown is now a themed control rather than the browser's own, so all
  of them match the rest of the interface.

### Removed

- The cost tier field and its `$$` badge. It fed no pricing, quota, rate
  limiting, or routing decision — it was a label whose only effect was to
  render itself, and once it left the model form nobody could edit it. The
  column is dropped in migration `0016`.

### Fixed

- The theme preview swatch showed the accent already in effect rather than the
  one it advertised.
- A section header in the sidebar was smaller than the 24px minimum target size
  required by WCAG 2.2.
- Accessibility scans no longer run while the theme transition is still
  animating, where they sampled blended colours and reported contrast failures
  against values nobody ever sees.

## [0.2.1] - 2026-08-07

### Fixed

- A reasoning model no longer leaves the screen blank while it thinks. The
  typing indicator was tied to the last message still being the user's, so it
  disappeared the moment an empty assistant message was created, which is
  exactly when a model begins working and the wait is longest. It now persists
  until the response actually produces something.

### Changed

- The reasoning panel opens itself while thinking is the only thing happening
  and collapses once the answer begins. An explicit click still wins.
- The model dialog explains whether a provider can show a model's thinking at
  all, since that depends on the wire protocol and the model rather than on any
  setting in this application.

## [0.2.0] - 2026-08-07

Governance and lifecycle management: what people are allowed to consume, how
long their data is kept, and what an operator can see about both.

### Added

- Quota policies can be scoped to specific models, so a family such as
  Anthropic or OpenAI carries its own independent budget. An unscoped policy
  still applies to every model, and a model in no policy remains unlimited.
- Per-user quota overrides with an optional expiry and reason, adjusting a
  limit the person's role already carries.
- Per-role storage allowances covering total bytes, stored file count, and
  maximum file size, enforced per user before an upload is written.
- Trash for deleted conversations, restorable until a configurable grace period
  elapses, with immediate permanent deletion and empty-trash actions.
- Optional retention for inactive conversations, usage history, audit entries,
  share links, and expired authentication artifacts. Security-relevant audit
  actions are kept regardless.
- Per-role concurrency caps and rate limits for chat and uploads, plus per-IP
  and per-account limits on authentication attempts.
- An administration usage report covering activity, spend by model and person,
  limit denials, and storage consumption, with a configurable reporting
  timezone. Every figure is a count or a total, and usage records carry no
  reference to a conversation.
- Configurable reservation amounts, so how much a run holds before its real
  usage is known can be tuned per instance.
- Single-conversation Markdown download.
- In-app usage warnings before a limit is reached, and a storage meter in
  attachment settings.
- A background job runner using per-job advisory locks, so scheduled
  maintenance runs once across replicas rather than once per replica, with an
  administration view of what ran and what it touched.
- Storage reconciliation that compares object storage against the database in
  both directions.

### Fixed

- Attachment objects are no longer orphaned when a thread or user is deleted.
  Cascading deletes bypass the application entirely, so a database trigger now
  queues every removed object for deletion with retries.
- Attachments are removed with the message they were sent on instead of being
  detached, which previously stranded both the row and its stored object and
  made an already-sent attachment appear re-sendable.
- Cost and token reservations now hold an estimated amount that settles to
  actual, so concurrent expensive generations can no longer read the same
  pre-spend total and collectively exceed a budget.
- Listing conversations no longer performs expiry cleanup as a side effect of a
  read.

### Changed

- Administration is reorganized: Governance holds usage, quotas, storage
  limits, rate limits, and retention, while Platform keeps service
  configuration and gains a Maintenance view. This separates what people are
  allowed to do from where things are wired up.
- Usage is presented to users as a percentage remaining rather than messages,
  tokens, or spend, and limit messages no longer quote the underlying figure.
- Storage drivers can enumerate stored objects, which reconciliation needs to
  detect objects with no database row and rows with no object.

### Upgrade notes

- Applying this release runs four migrations, one of which adds a trigger on
  the attachment table and backfills per-user storage counters.
- Deleting a conversation now moves it to a trash for 30 days by default rather
  than removing it immediately. Adjust or disable this under
  **Governance → Retention**.
- Automatic conversation retention is off by default and must be enabled
  deliberately.
- Storage allowances and rate limits start unlimited and unenforced; existing
  behavior is unchanged until an administrator sets them.

## [0.1.0] - 2026-08-07

Initial release.

### Added

- Multi-model chat with streaming responses, reasoning controls, Markdown, KaTeX,
  syntax-highlighted code, model attribution, and a curated model catalog.
- Local email/password authentication plus administrator-configured OIDC and
  SAML, invite/open/closed registration, account linking controls, and
  `admin`, `user`, and `restricted` roles.
- Immutable message branching, conversation forks and lineage, pinned and
  archived threads, temporary chats, and privacy-filtered public share links.
- File attachments with strict validation, extraction, ownership checks, local
  or S3-compatible storage, and an attachment manager.
- Grounded web search through Tavily, Brave, Exa, or self-hosted SearXNG, with
  persisted citations and external-link confirmation.
- Administration for providers, models, quotas, users, invitations, SSO, SMTP,
  storage, search, branding, themes, and audit events.
- Message, token, and cost quotas with rolling or calendar windows, concurrent
  reservations, and integer micro-dollar accounting.
- Redis-backed resumable streams, multi-replica-safe database migrations, Caddy
  service discovery, and readiness/liveness health checks.
- Docker Compose deployment and versioned API/web images in the GitLab
  container registry.
- Automated linting, type checking, unit/integration/live tests, Playwright and
  WCAG 2.2 AA regression checks, SAST, dependency scanning, SBOM generation,
  license policy enforcement, and GitLab Code Quality reporting.

### Security

- Provider credentials and other managed secrets are encrypted at rest and use
  write-only update semantics.
- Chat history, model resolution, attachment access, branching, and sharing are
  reconstructed and authorized server-side rather than trusted from clients.
- Outbound provider URLs are scheme-validated, search input cannot select an
  origin, and browser API requests are constrained to the current origin.
- External links require explicit confirmation, with optional remembered
  consent.

### Known limitations

- Automated accessibility testing is a regression net, not a complete WCAG
  conformance assessment; manual assistive-technology testing is still advised.
- Local attachment storage is suitable for a single API replica. Multiple
  replicas require shared S3-compatible object storage.
- Token and cost quotas depend on providers returning usage metadata. Providers
  that omit it record zero tokens and cost.
- This initial release has no earlier database version to roll back to. Back up
  PostgreSQL and attachment storage before future upgrades.

[Unreleased]: https://github.com/ncecere/open-chat-interface/compare/v0.11.0...main
[0.11.0]: https://github.com/ncecere/open-chat-interface/releases/tag/v0.11.0
[0.10.2]: https://github.com/ncecere/open-chat-interface/releases/tag/v0.10.2
[0.10.1]: https://github.com/ncecere/open-chat-interface/releases/tag/v0.10.1
[0.10.0]: https://github.com/ncecere/open-chat-interface/releases/tag/v0.10.0
[0.9.2]: https://github.com/ncecere/open-chat-interface/releases/tag/v0.9.2
[0.9.1]: https://github.com/ncecere/open-chat-interface/releases/tag/v0.9.1
[0.9.0]: https://github.com/ncecere/open-chat-interface/releases/tag/v0.9.0
[0.8.0]: https://github.com/ncecere/open-chat-interface/releases/tag/v0.8.0
[0.7.0]: https://github.com/ncecere/open-chat-interface/releases/tag/v0.7.0
[0.6.1]: https://github.com/ncecere/open-chat-interface/releases/tag/v0.6.1
[0.6.0]: https://github.com/ncecere/open-chat-interface/releases/tag/v0.6.0
[0.5.0]: https://github.com/ncecere/open-chat-interface/releases/tag/v0.5.0
[0.4.1]: https://github.com/ncecere/open-chat-interface/releases/tag/v0.4.1
[0.4.0]: https://github.com/ncecere/open-chat-interface/releases/tag/v0.4.0
[0.3.0]: https://github.com/ncecere/open-chat-interface/releases/tag/v0.3.0
[0.2.1]: https://github.com/ncecere/open-chat-interface/releases/tag/v0.2.1
[0.2.0]: https://github.com/ncecere/open-chat-interface/releases/tag/v0.2.0
[0.1.0]: https://github.com/ncecere/open-chat-interface/releases/tag/v0.1.0
