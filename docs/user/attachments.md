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

This is the part that catches people out. Attaching an image to a model without
**vision**, or a PDF to one without **PDF comprehension**, gets you a reply that
politely fails to mention the file.

The picker shows those abilities as coloured icons beside each model name, and
its filter narrows the list to models that have them. Check before attaching
rather than after.

## A worked example: asking about a document

1. Choose a model showing the document icon — filter by **PDF comprehension** if
   you are not sure which do.
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

Attachments count towards any storage limit your institution sets. If you reach
it, deleting old files from here is what frees space — deleting the conversation
alone does not, immediately, because a deleted conversation is recoverable for a
period first.

## What happens to a file

Uploads are stored by the instance, not sent to a third party for storage. When
you send a message with an attachment, the file's contents go to the model
provider chosen for that message, in the same way the text of your message does.

If that matters for what you are working with, ask your administrator which
providers the instance is configured to use.
