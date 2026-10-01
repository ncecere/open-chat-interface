# Models and providers

![Providers](../images/admin-providers.png)

## Providers hold credentials

A provider is an upstream service and the key used to reach it. Adding one makes
its models *available to add*; it does not expose anything to your users.

That separation is deliberate. A provider offering forty models should not
present forty to your institution — you choose which are appropriate and which
roles may use them.

### Credentials are write-only

Once saved, a key is encrypted and never returned. The form shows whether one is
set, not what it is. Replacing it means entering a new one; there is no way to
read the old value back, including for you.

Rotating `ENCRYPTION_KEY` in the environment makes every stored credential
unreadable and they must all be entered again. Do not rotate it casually.

## The model catalogue

![The model catalogue](../images/admin-models.png)

Each entry maps a name your users see to an upstream model identifier.

### Discovering models

**Discover** asks the provider what it offers and lists what is not yet in your
catalogue. Faster than typing identifiers, and it will not silently add
anything.

### Fields that matter

- **Display name** — what appears in the picker. This is for your users, so
  "GPT-5.6 Luna" beats `gpt-5.6-luna-20260115`.
- **Description** — shown on the model's information card. Worth writing. Left
  blank, the interface falls back to listing capabilities, which tells somebody
  what the model *can do* but not when to reach for it.
- **Capabilities** — vision, reasoning, tool calling, PDF comprehension and so
  on. These drive the picker's icons and its filter. **Getting them wrong is
  worse than leaving them blank**: somebody will attach a PDF to a model that
  cannot read one and get a reply that never mentions it.
- **Visible to roles** — which roles see it. This is how an expensive model is
  kept to the people who need it.
- **Context window** — used to budget provider input. If unset, the application
  uses a 32,768-unit fallback. Keep it aligned with the upstream model.
- **Max output tokens** — reserved before input selection and explicitly passed
  on every request. If unset, the default is 4,096, or one quarter of a smaller
  context window. A configured output cap that leaves no input space is rejected.

For budgeted Anthropic thinking models, the output limit includes both thinking
and the visible answer. The application allocates 10%, 30% or 60% to low, medium
or high thinking, with a 1,024-token minimum and some answer capacity retained.
The installed adapter adds thinking to its answer limit, so OCI subtracts it
from that SDK parameter first. Known adapter output ceilings are also respected.
Limits of 1,024 or less cannot enable legacy thinking: choose Instant or increase
the configured limit. Adaptive models keep the SDK's adaptive effort control.

### Input safety ceilings

Input selection reserves output space and a 512-unit framing margin, then keeps
a contiguous recent suffix of whole turns. Text is estimated conservatively from
UTF-8 bytes plus framing, not a provider-specific tokenizer. Images receive an
8,192-unit allowance each; provider-specific limits can still reject a request.

The application caps input at 128,000 estimated units, scans at most 129 recent
message descriptors to select at most 128 historical messages, and selects at
most 512 KiB of serialized stored message parts. File metadata is inspected
before contents are loaded. A request can include at most 32 files and 20 MiB of
image data in its selected context, independently of upload/storage limits.

Required latest-turn content, system instructions and current search grounding
are never silently shortened. Oversized required input is rejected before the
new prompt is persisted. Older history may be omitted, with a notice on the
reply. These are safety bounds, not precise token counts or latency measurements.

Ready payloads are immutable through normal application writes. Storage corruption
or out-of-band mutation is different: blob reads currently buffer before checking
actual length, and stored message reads check aggregate size after individually
bounded rows arrive. The acceptance limits are not hard peak-memory guarantees
when stored contents diverge from their inspected metadata.

### The default model

Set under **Settings → General**, not here. It is what a new conversation starts
with, so it should be something reasonable for everyday work rather than your
most capable option.

## A worked example: adding an expensive model for one group

The case is common: a capable, costly model that should not be available to
everybody.

1. **Add the provider**, if it is not already configured.
2. **Discover** its models and add the one you want.
3. Set **Visible to roles** to `admin` only, for now.
4. Confirm it appears in your own picker and answers correctly.
5. In [Auth & SSO](identity.md), map the group that should have it — say
   `oci-researchers` — to a role.
6. Add that role to the model's visibility.
7. Set a [quota](governance.md#usage-quotas) scoped to that model, so access does
   not mean unlimited access.

Step 7 is the one people skip. Visibility decides who *can* use a model; a quota
decides how much. Without it, restricting the model to a group only narrows who
can spend the budget, not how fast.
