# Attachments

Attach a file with the paperclip beside the composer, or by dragging it onto
the page.

## What you can send

By default an instance accepts PNG, JPEG, WebP, and GIF images, PDFs, and plain
text, up to 20 MB each and ten files per message. Your administrator can change
all of that, so an instance may accept more or fewer types.

Files are checked by their **contents**, not their extension. Renaming a file to
`.png` will not get it accepted, and a genuine PNG with the wrong extension will
be.

## The model has to be able to read it

Images require a model with **vision**. Otherwise the model receives an
unreadable-file notice, not the image. The picker shows model abilities and lets
you filter for them.

PDFs and text files are sent as extracted text. A model's PDF capability does not
change that extraction path: page layout, diagrams and scanned text may not be
available. If extraction fails, the model receives an unreadable-file notice.

## A worked example: asking about a document

1. Choose a model suited to your document questions.
2. Attach the PDF. A chip appears above the composer while it uploads.
3. Ask something specific: "What does section 4 say about data retention?"
   rather than "summarise this".
4. Send.

Being specific matters more with a long document than with a short question. A
model asked to summarise forty pages will do so at whatever length it chooses;
asked about section 4, it answers about section 4.

## Managing what you have sent

[Settings → Attachments](settings.md#attachments) lists everything you have
uploaded, with the conversation each belongs to, and lets you delete files you
no longer want kept.

Attachments count towards any storage limit your institution sets, including
uploads still in progress. Deleting a file or moving its conversation to trash
frees its allowance immediately; physical deletion happens later. Restoring a
conversation requires enough space for its files again.

Simultaneous uploads share the same allowance. If another upload takes the last
available space, a later one may be refused even if the meter showed room when
you started it.

## What happens to a file

Uploads are stored by the instance, not sent to a third party for storage. When
you send a message with an attachment, the file's contents go to the model
provider chosen for that message, in the same way the text of your message does.

Follow-ups and regenerated replies can resend earlier attachments in the
conversation context. Switching models can send those contents to a different
provider. Ask your administrator which providers are appropriate for your data.
Deleting a file cannot recall contents already sent to a provider.

Forks reference the original file rather than making an independent copy. If
that file or its source conversation becomes unavailable, the fork cannot use
its contents. Current role and attachment-feature restrictions also apply to
historical files; a file-free conversation can still be used when file access
is disabled.

If a file is being changed or deleted while a reply is prepared, the request may
be refused as unavailable or busy. Retry after the file operation finishes;
that failed preparation does not save a new user turn.
