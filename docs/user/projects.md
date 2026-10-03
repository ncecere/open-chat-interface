# Projects

A project groups conversations that belong together, such as a thesis, a
course or a grant application, under instructions and files they all share.
Every conversation in the project gets the project's instructions and can read
its files, so you do not have to paste the same background into each new chat.

Projects are private to you. Your administrator decides whether your role can
use them; if the **Projects** section is missing from the sidebar, they are off
for your role.

## Creating a project

1. In the sidebar, select **+** beside **Projects** (or the prompt shown when
   you have none).
2. Give the project a name (up to 100 characters). Instructions are optional
   and can be added later.
3. Select **Create project**. The project's page opens.

You can have up to 100 projects.

## The project page

Open a project from the sidebar. **New chat in project**, at the top, starts a
conversation inside the project. Below it, the page has four tabs:

- **Conversations** in the project, most recent first. The page opens on this
  tab.
- **Instructions**, up to 8,000 characters. Select **Save changes** after
  editing.
- **Files.** Upload up to 20 files. They are checked and stored like
  [attachments](attachments.md), count towards your storage allowance, and need
  file attachments to be available to you. Each file shows whether it can be
  searched (see [Large projects](#large-projects)):
  - **Searchable · *n* passages**: its text was split into *n* passages that
    can be searched.
  - **No text to search**: nothing could be read from it, such as an image or
    a scanned PDF. It is always given to the model whole, as far as it fits.
  - **Waiting to be indexed**: the file was added before your institution
    upgraded and has not been prepared yet. This happens automatically in the
    background, usually within minutes; until then the file is used whole.
- **Settings**: rename the project, or delete it.

The open tab is part of the page address, so a reload or a shared link opens
the same tab.

## Starting and moving conversations

**New chat in project** opens the usual new-chat screen, marked "New chat in
*project name*". The conversation you start there belongs to the project.
Temporary chats cannot be part of a project.

To move an existing conversation, open it and select **Move to project** (the
folder button at the top right). Choose a project, or **No project** to take
it out. The change applies from the next reply.

Forks and edited branches stay in the same project as the conversation they
came from.

## Projects in the sidebar

Under **Projects** in the sidebar, each project has an arrow that shows or
hides its conversations; select the project's name to open its page.

- Projects start collapsed. Whether you open or close each one is remembered
  in this browser.
- An open project lists its five most recent conversations. When it has more,
  **Show all (*n*)** opens the project's **Conversations** tab; *n* counts
  every conversation in the project, pinned ones included, but not archived
  ones.
- The project of the conversation or project page you are viewing opens by
  itself while you are there, without changing what is remembered. The open
  conversation is listed and highlighted under its project even when it is not
  among the five most recent.
- Pinned conversations are listed only under **Pinned**, with the project's
  name after their title, not under their project. A project whose only
  conversations are pinned shows just **Show all (*n*)**.
- Conversations in a project are not repeated in the sidebar's date groupings.
  Searching the sidebar or `Cmd/Ctrl + K` still finds them, with their
  project's name.

## What the model receives

With every message in a project conversation, the model receives:

- **The project's instructions**, added to the system prompt after your
  institution's instructions and your own
  [personalisation](settings.md). They are marked as project instructions, and
  your institution's instructions take precedence where they conflict.
- **The text of the project's files**, read the same way as attachments: text
  and PDFs as extracted text, images only by models with vision. Files are
  given to the model before older parts of the conversation, so when space is
  short the oldest messages are left out first.

When all of the project's files fit in the selected model's context, they are
given to the model whole. When they do not, see [Large projects](#large-projects).

## Large projects

When a project's files are too large to give the model in full, the model gets
the parts of them that matter for your message instead:

- Your message is searched for in the project's files, by keyword. Passages
  that contain more of your words, and rarer ones, rank higher; common words
  such as "the" count for little. Use the words you expect to find in the
  files, such as names, terms and numbers.
- Only passages that are relevant to your message are given to the model,
  labelled with their file name and passage number, in the order they appear
  in the files. A passage counts as relevant when it contains a word of your
  message that is specific to some part of the files (a word found almost
  everywhere in them, or a word such as "what" or "about", is not enough) and
  matches nearly as well as the best passage. A specific question therefore
  gets a few passages, a broad one ("summarise the leave policy") the passages
  on that topic, and they use at most half of the model's context, so the
  recent conversation still fits.
- If your administrator has turned on **meaning-based search**, the files are
  also searched by meaning: a passage that answers your question in other words
  ("start the boiler" for "turn on the heating") can be found even when it
  shares no word with your message. The two rankings are merged, so exact
  names, codes and numbers still come first.
- If nothing in the files is relevant to your message, for example when you
  ask about something else entirely ("write a poem about the sea"), no
  passages are used and the reply has no note about the project's files. The
  model is only told which files the project has, so it can suggest asking
  about a specific topic in them. Meaning-based search, when it is on, also
  leaves out passages that are not close in meaning to your message.

Your administrator may also have turned on **reranking**. A reranking model
then reads your message together with each of the best matches and puts the
ones that actually answer it first, leaving out those it judges unrelated, so
the passages given to the model are more likely to be the right ones. The note on such a reply says so, for
example "Searched project files and reranked the results". Each reranked message counts towards your usage, under
a model name starting with `rerank:`. If the reranking model is slow or
unavailable, the reply still comes, with passages in the usual order.

A reply that used searched passages says so above its text, for example
"Searched project files. Used passages from handbook.pdf (2 passages)", or
"Searched project files by meaning and keywords" when meaning-based search
was used. If meaning-based search is unavailable for a moment, the reply still
comes, searched by keyword only. With meaning-based search on, each passage of
your files is processed by the instance's embeddings model once when it is
indexed, and each question once when you ask it; both count towards your
usage, under a model name starting with `embedding:`. The
model does not see the rest of the files for that message, so ask about
specific topics rather than for a summary of everything, and use the words
the files use: keyword search cannot tell what a shared word means, so "plan
a trip" can still bring up passages about "data management plans". A model with a larger
context can take more of the files, or all of them.

Search only covers your own project's files, never another project's or
anyone else's. Files with no text to search, and files still waiting to be
indexed, are given whole if they fit; a file that does not fit is left out
rather than cut off, and the reply is marked as having limited context.

Nothing from the project is written into the conversation itself. Exports and
share links show the conversation as it was written; a shared conversation
never includes the project's instructions or files. The note on a searched
reply names the files and counts the passages but never contains their text;
it is kept with the reply in your own data export and left out of share links. Like any attachment, a
project file's contents go to the provider of the model you chose for that
message.

## Deleting

**Removing a file** deletes it straight away, with its searchable passages,
and frees its storage. It is not moved to the trash.

**Deleting a project** keeps its conversations: they simply leave the project.
Its files are deleted and their storage freed. This cannot be undone.

Projects are not affected by your institution's conversation retention. A
conversation in a project can still be moved to the trash after a period of
inactivity, like any other; restoring it puts it back in the project if the
project still exists.

## If projects are switched off for your role

Your projects are kept, but you cannot open, change or create them, and their
instructions and files stop being added to conversations. Conversations that
were in a project carry on as ordinary conversations. If projects are turned
back on, everything is as you left it.

If file attachments are not available to you, a project's instructions still
apply but its files are not used.

## Exporting

[Exporting your data](your-data.md) includes your projects: `manifest.json`
lists each project's name, instructions, files and conversations, and the files
themselves are under `projects/<project name>/`.
