# Memory

Memory is a short list of notes about you, such as your job, how you like
answers or a project you are working on, that OCI includes in your
conversations so you do not have to repeat yourself. It is off until you
switch it on, and you can see, change and delete every note.

Your administrator decides whether memory is available. If **Settings →
Memory** says it is not available to you, it has been switched off for the
instance or for your role.

## Switching it on

1. Open **Settings → Memory**.
2. Turn on **Use memory**.

Turning it off stops your notes being used and stops models saving new ones.
Your notes are kept until you delete them, so turning it on again picks up
where you left off.

## How notes are made

**You can write them yourself.** Under **Add a memory**, type a note (up to
500 characters) and select **Add**. Write it as a fact about you: "I teach
first-year chemistry" or "Prefers answers in British English".

**Models can save them.** With memory on, models that use tools can save a note
when you ask them to remember something, or when you mention a lasting
preference or fact that would help later. They can also forget a note when you
ask, or when it is no longer true. Each change appears in the reply as
**Memory updated**, with the note's text and an **Undo** button. Undo deletes a
note the model saved, or restores one it removed.

Models that do not use tools still read your notes; they just cannot change
them.

## How notes are used

Your notes are added to the instructions the model receives at the start of
every conversation, newest first, marked as notes about you rather than
instructions. They take at most a small, fixed share of what the model can
read (5% of its input, and never more than about 8 KB), so on a model with a
small input limit only your most recent notes are included.

**Temporary chats never use memory.** They neither read your notes nor save
new ones, whatever your setting.

## Managing your notes

**Settings → Memory** lists every note, newest first, with where it came from
(*Added by you* or *Saved by a model*) and when it last changed.

- **Edit** changes a note's text.
- **Delete** removes one note, after asking you to confirm.
- **Delete all…** removes every note, after asking you to confirm. This cannot
  be undone.

You can keep up to 200 notes. When you reach the limit, delete some before
adding more; a model that tries to save another is told the limit is reached.

Even when memory is not available to you, the page still lists your notes so
you can review and delete them.

## Your data

- Your notes are included in your [full export](your-data.md#exporting-everything),
  in `memory.json`.
- Your administrator may set notes to be deleted when they have not changed for
  a number of days. Editing a note counts as a change.
- Administrators can see that notes were added, changed or deleted, and how
  many, in the audit log. They never see what a note says there.
- Deleting your account deletes your notes.
