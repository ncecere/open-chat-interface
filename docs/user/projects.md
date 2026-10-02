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

Open a project from the sidebar. Its page has:

- **Name and instructions.** Instructions can be up to 8,000 characters. Select
  **Save changes** after editing.
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
- **Conversations** in the project, most recent first.
- **New chat in project**, which starts a conversation inside the project.
- **Delete project.**

## Starting and moving conversations

**New chat in project** opens the usual new-chat screen, marked "New chat in
*project name*". The conversation you start there belongs to the project.
Temporary chats cannot be part of a project.

To move an existing conversation, open it and select **Move to project** (the
folder button at the top right). Choose a project, or **No project** to take
it out. The change applies from the next reply.

In the sidebar, a conversation in a project shows the project's name after its
title. Forks and edited branches stay in the same project as the conversation
they came from.

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
- The best-matching passages are given to the model, labelled with their file
  name and passage number, in the order they appear in the files. They use at
  most half of the model's context, so the recent conversation still fits.
- If no word of your message appears in the files, the opening passages of
  each file are used instead.

A reply that used searched passages says so above its text, for example
"Searched project files. Used passages from handbook.pdf (2 passages)". The
model does not see the rest of the files for that message, so ask about
specific topics rather than for a summary of everything. A model with a larger
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
