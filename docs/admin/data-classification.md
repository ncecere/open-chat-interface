# Data classification

**Administration → Models → Data classes** (`/admin/data-classes`). Say which models and
connectors may handle which kinds of data, and have OCI refuse (or warn) when
labelled content would reach one that is not approved. Added in v0.14.

This is a control on OCI's own paths. It is not data-loss prevention: see
[What it does not control](#what-it-does-not-control).

## The idea

- A **data class** is a name you choose, such as "Student records" or "Health
  data", with an optional description. There is no ranking or hierarchy: a
  class is a label, and approvals are per class.
- A **model is approved for classes.** A new model is approved for **nothing**:
  deny by default. A model that is approved for no class cannot receive labelled
  content.
- A **connector carries classes.** What a connector returns becomes part of the
  conversation, so a conversation that has used a connector that carries
  "Student records" carries it too.
- A **conversation carries classes** from three places, together:
  - its **project's labels**;
  - the **connectors whose tools it has used** (once used, always: the
    conversation holds that data from then on);
  - **labels a person adds** to the conversation themselves.
- **An unlabelled conversation is not affected.** Switching the feature on
  changes nothing until something is labelled.

When a person sends a message, OCI works out the classes the conversation
carries and compares them with what the chosen model is approved for. If any
class is missing, the message is refused (mode **Block**) or goes ahead with a
note and an audit entry (mode **Warn**). This is decided on the server; the
model picker only shows the result.

## Modes

| Mode | What happens |
|---|---|
| **Off** (default) | "Nothing is checked and nothing changes for anyone." Connector use is still recorded, so that labelling a connector later reaches conversations that used it earlier. |
| **Warn** | "Nothing is refused: what Block would have refused goes ahead, with a notice, and is recorded in the audit log." A send, tool call, search or share that Block would have refused goes ahead, and an audit entry (`classification.warn`) records it. A dry run of Block. See [Known limitations in Warn](#known-limitations-in-warn). |
| **Block** | "Anything that would carry a class to a model or service that is not approved for it is refused." If OCI cannot read the classes (the database is unavailable), it refuses rather than guess. |

You cannot turn on Warn or Block until the upgrade to 0.14 has finished on every
server (see [Upgrading](#upgrading-and-the-mixed-version-window)). Until then
the page shows **The upgrade to 0.14 is not finished**, and saving Warn or Block
answers "The mode was not changed. The upgrade to 0.14 has not finished on every
server, so Warn and Block cannot be turned on yet. Run “migrate --post” …".
While the background migration is still running the page says **Finding which
conversations used connectors before 0.14**; the mode can be turned on then,
because OCI reads each conversation's own messages in the meantime. In Warn or
Block, **Some connectors are not reviewed** counts the connectors nobody has
labelled.

## Setting it up

Do it in this order, so that nobody is surprised:

1. **Define the classes** under **Data classes**. Keep the list short; a name
   is shown to people in their own conversations. Rename a class at any time (its
   labels and approvals follow). **Retire** one to hide it from pickers and refuse
   new labels: what it already labels and approves **still counts**. A class can
   be **deleted** only when nothing refers to it (the page shows how many
   connectors, projects and conversations still do); there is deliberately no
   force, because it would unlabel content silently.
2. **Approve models.** Under **Providers & Models**, edit a model and choose
   **Approved for**. Empty reads "No class: this model cannot receive labelled
   content". It is saved with the model; if only the approvals fail to save, the
   form says the model was saved but the classes were not.
3. **Label connectors.** On **Connectors**, choose what each **Carries**, or
   "Carries no classified data" when it carries none. A connector nobody has
   looked at shows **Not reviewed**. With classification on, a new connector
   cannot be saved without one of the two, so that forgetting to label it is
   visible. An unlabelled connector is unaffected by every decision.
4. **Approve outside services** under **Other services**: **Web search may
   receive**, **Meaning-based project search may receive** (embeddings) and
   **Reranking may receive** each have a list of classes. The default is none, so
   a conversation that carries any class does not use them.
5. **Turn on Warn.** Let people work normally for a while and read the audit log
   (below) for `classification.warn` entries: they are what Block would have
   refused.
6. **Turn on Block** when the warnings show nothing unexpected.

Project labels are set by the project's owner in the project's **Settings** tab,
under **Data classes**. You can also label a person's project yourself: open the
person under **Users** and use **Project data classes**. A label you save there
is **locked**: only an administrator removes it, and the owner sees it as "set by
an administrator". (Project names are shown to administrators only there.)

The classes list shows, for each class, the number of models approved, connectors
carrying it, projects and conversations labelled with it. **Rename** keeps the
class's id, so labels and approvals follow. **Retire** hides it from the label
lists and stops new labels (what it already labels and approves still counts).
**Delete** is offered only when no connector, project or conversation refers to
it, and the dialog says how many do; there is no force. Auditors can read the
whole page and change nothing.

## What is checked

Everywhere content reaches a model, or leaves OCI, is checked. In **Block** the
check is made in the server before the content goes:

| Where | What leaves | When it is not approved |
|---|---|---|
| **Sending a message** (also Retry and regenerate) | The prompt, history, files, project instructions and passages, memories and summary go to the model | Refused with a message naming the missing classes and the approved models; nothing is stored, and the text goes back to the message box |
| **Continuing a reply after approving a tool** | The continued reply goes to the reply's own model | Refused; the reply keeps waiting for an answer |
| **A connector tool** | The tool's arguments go to the connector; its result enters the conversation | Not offered to the model if the connector carries a class the model is not approved for; refused again when the call is about to run (the model is told the tool is unavailable) |
| **Web search** (the tool, or the search before a reply for models without tools) | The model's query, or the whole message, goes to the search provider | The search is not made; the reply says so |
| **Summarising earlier messages** (by hand or in the background) | The earlier transcript goes to the model | A manual request is refused; an automatic one ends quietly (and is audited) |
| **Memory** | A note written from a labelled conversation could later reach any model | `remember` is not offered in a conversation that carries a class (in Warn too); notes you or the person write by hand are unaffected |
| **Project search** | The question goes to the embeddings provider; the question and passages go to a reranker | The meaning-based side (or the reranking) is skipped and the project note says so |
| **Indexing project files** | Passages go to the embeddings provider | Files of a project that carries a class not approved for embeddings are not embedded (keyword search still works) |
| **Share links** | The whole conversation goes to anyone with the link | Never approved: creating a link is refused; an existing link of a conversation that gets labelled **stops working** (404) while it is labelled, and works again if the label goes. It is paused, not revoked |

A label is never lost as a side effect: moving a conversation out of a project,
deleting a project or a connector, and forking a conversation all **keep** the
labels (as "kept" labels the person cannot remove). Only someone entitled to
change the declaration changes it, and that is audited.

Labels are **not retroactive for messages already sent**: a conversation labelled
after it went to a model that is not approved is refused from its next message;
the earlier one is not recalled. A message sent at the moment a label is added
may go through once.

## What people see

- Chips at the top of a conversation show each class and why ("from the
  project", "from the SIS connector", "added by you", "kept from its earlier
  project"). **Add label** lists the classes that are not retired. People remove
  the labels they added (an **×**); the others are explained in a sentence.
- The model picker keeps unapproved models in the list, with "Not approved for
  Student records" as text, `aria-disabled` and reachable with the arrow keys
  (in Warn they stay selectable, with an amber note). A default is never an
  unapproved model: a new chat in a labelled project starts on an approved one.
  A note above the message box says when the chosen model is not approved.
- A refused send (403 `DATA_CLASS_BLOCKED`) keeps the text in the message box,
  shows the server's sentence and lists the approved models as **Use *model***
  buttons.
- A reply sent in Warn carries a note ("It was sent anyway because data
  classification is set to warn"); a reply whose project search left out
  meaning-based search or reranking says so.
- A share link of a labelled conversation shows as **paused**; in Warn, creating
  one shows a notice.

## Known limitations in Warn

In Warn, only a **send** adds a note to the reply (the `data-classification`
part, written once per reply, and only when the chosen model is not approved for
what the conversation carries at that moment). What Warn lets through at the
other places is **recorded (`classification.warn`, and the counter) but not shown
to the person**:

- a **connector tool** that runs (OCI cannot tell the person at that moment that
  the connector's classes are not approved for the model; once it has run, the
  conversation carries them, the chips update when the reply finishes, and the
  next send gets the note above);
- the **web search**, in the tool and before a reply;
- **meaning-based project search and reranking** (`withheld` is only set in
  Block, where they are actually left out);
- **summarising earlier messages**.

`remember` is withheld in Warn as in Block, quietly. If you need to see these,
read the audit log: `classification.warn` entries name the `point` (`tool`,
`web_search`, `embedding`, `rerank`, `compaction`), the tool id and the missing
classes. Block does not have the gap for tools and searches that are withheld:
the model is told the tool is unavailable and the reply says a search was not
made.

## The audit log and metrics

Entries carry ids and the names of classes **as they were at the time**, the
point, the kind of destination, the model's slug and the tool id. They never
carry message text, titles, tool arguments or results.

| Action | When |
|---|---|
| `data_class.create`, `.update`, `.retire`, `.delete` | You change the list (a rename records both names) |
| `model.data_classes.update`, `connector.data_classes.update` | You change approvals or what a connector carries |
| `settings.classification.update` | You change the mode or the services' approvals |
| `project.data_classes.update` | A project's labels change (by an administrator or its owner) |
| `thread.data_class.add`, `.remove` | A person labels or unlabels their conversation |
| `classification.block`, `classification.warn` | Something was refused, or (Warn) would have been |

The first group is **protected from audit retention**; the person's own label
changes and the block and warn events follow normal retention. All of them are in
the [compliance export](compliance.md) and webhooks like any audit event, so class
names can appear there.

The Prometheus counter `oci_classification_decisions_total{point,outcome}`
counts decisions for conversations that carry a class (`point` is send,
approval, tool, compaction, web_search, embedding, rerank or share; `outcome`
is allowed, warned or blocked). It has no class label: names may be sensitive.
Logs and traces never contain class names either.

## What it does not control

Classification governs OCI's own paths. It does **not** control:

- copying text from one conversation into another, screenshots and downloads;
- **what a labelled conversation sends to an unlabelled connector**: a connector
  tool's arguments are written by the model from the conversation, and only the
  data coming *back* from a connector is judged. If a connector must not receive
  Student records, do not enable its tools for the people who work with them;
- anything on a model provider's side: an approval is your statement about a
  provider, not something OCI can verify;
- a title (it is cut from the first message by OCI, with no model);
- exports of a person's own data to that person, and the compliance export,
  which is yours.

## Upgrading and the mixed-version window

Migration 0052 is additive. **While servers of different versions run (a rolling
upgrade), and after a rollback to v0.13, classification is not enforced:** a
v0.13 server does not check, does not record which connectors a conversation
used, and ignores the setting. Labels stay consistent when it forks, moves or
deletes things (database triggers), but it can send labelled content to any
model it can reach.

Because of that you cannot turn on Warn or Block until `migrate --post` has run
(after every server runs 0.14). It schedules a background migration,
`0.14.thread-connector-use`, which finds the connector tools that conversations
used before 0.14 (including by a v0.13 server during the upgrade) in the stored
messages, so that those conversations carry the connector's classes. Until it
finishes, OCI also reads the conversation's own messages when it decides, so
nothing waits for it; check **System health → Background migrations**. The Data
classes page shows a banner while the upgrade is unfinished or the backfill
runs. See [Upgrading to v0.14](../OPERATIONS.md#upgrading-to-v014).
