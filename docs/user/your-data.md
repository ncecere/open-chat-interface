# Your data

You can download a copy of everything you have stored here, and you can bring
your history in from ChatGPT or Claude. Both are under
[Settings → History](settings.md#history-and-sync), in the **Your data**
section.

## Exporting everything

**Export all conversations** downloads a `.zip` file. It starts straight away
and is put together while it downloads, so a large history takes a little
while but does not need to be prepared in advance.

The archive contains:

- `conversations/` — two files per conversation, named after its title and
  start date. The `.md` file is the readable version, the same as downloading
  a single conversation. The `.json` file is the complete record: every
  message as stored, including model reasoning, which the Markdown leaves out,
  and the list of attached files.
- `attachments/` — the files you attached, in a folder per conversation. Files
  you uploaded but never sent are in `attachments/unsent/`.
- `manifest.json` — when the export was made, the OCI version, how many
  conversations, messages and files it contains, and an index of every
  conversation.
- `README.txt` — a short description of the above.

Active and archived conversations are included. Conversations in the trash,
temporary chats and deleted files are not.

You can run one export at a time, and a few per hour. Very large exports are
capped: past 2 GB of attached files, further files are listed in
`manifest.json` but left out, and the manifest says the export was truncated.

## Importing from ChatGPT or Claude

1. Request an export from the other service.
   - **ChatGPT:** Settings → Data controls → Export data. You get an email with
     a link to a `.zip` file.
   - **Claude:** Settings → Privacy → Export data. Choose all dates, not only
     recent ones. You get an email with a link to a `.zip` file.
2. In **Your data**, choose **Choose export file** and pick the `.zip`. You can
   also upload the `conversations.json` file from inside it.
3. The upload shows its progress. Once it finishes, the import runs in the
   background. You can leave the page; the list shows when it is done and how
   many conversations were imported, skipped, or could not be read.

Imported conversations appear in your sidebar with their original titles and
dates. Only what you saw on screen is brought across: your messages and the
replies you kept. Where the other service kept several versions of a reply, the
one you were last looking at is imported. Model reasoning is kept as a
collapsed reasoning panel where the export includes it. Tool calls, search
steps, custom instructions and other hidden parts of the conversation are left
out.

Neither service includes your attached files in its export, so attachments are
listed by name in the message instead (for example, "Attached in ChatGPT:
diagram.png (file not imported)").

### Limits and behaviour

- **One import at a time.** Wait for an import to finish before starting
  another. A queued import can be cancelled; a finished one can be removed from
  the list, which does not remove the conversations it imported.
- **File size.** Uploads up to 512 MB are accepted unless your administrator
  has changed the limit. Until it has been processed, the upload also counts
  against your storage allowance; it is deleted as soon as processing ends.
- **Importing again is safe.** Conversations that were already imported are
  skipped, not duplicated, so you can import a newer export to pick up new
  conversations. A conversation that changed at the source since you imported
  it is also skipped, so anything you have added to it here is never
  overwritten. To import it afresh, delete it here permanently (including
  from the trash) first.
- **Usage.** Imported messages are history, not new replies, so they do not
  count towards your usage limits.
- **Retention.** Imported conversations keep their original dates. If your
  institution removes conversations after a period of inactivity, imported
  conversations older than that period move to the trash at the next cleanup,
  like any other conversation that old.
- **Unrecognised content.** Both services change their export format from time
  to time. Content the importer does not recognise is left out and counted in
  the import's details rather than stopping the import.
- **Damaged or unsafe files are refused.** An archive that is incomplete,
  expands to far more data than its size suggests, or contains unusual file
  paths is rejected with an explanation, and nothing from it is imported.

If an import fails, the list shows why. Most failures are the wrong file: make
sure you are uploading the export `.zip` itself, not a file from inside a
different folder.
