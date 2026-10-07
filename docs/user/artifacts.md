# Artifacts

When a reply contains something you will want to use on its own, such as a web
page, an image, a diagram or a long document, OCI keeps it as an **artifact**: a
separate object with its own versions, which you can open, copy and download.

## What becomes an artifact

- **HTML pages.** An HTML code block that is a whole page, or at least ten
  lines long. Short snippets stay ordinary code blocks.
- **SVG images.** Any complete SVG.
- **Mermaid diagrams** of three lines or more. The diagram still appears in the
  reply, with a card below it.
- **Long documents you ask for.** Models that can use tools can also create a
  long document you ask for, such as a report or plan, and revise it later.
  Program code, tables, lists and short answers stay in the reply unless you
  ask for an artifact: OCI does not save a document that is mostly code or
  only a few hundred characters long, and the model writes it in its reply
  instead. Such an attempt is not shown in the reply: no step, no card and
  no artifact panel. A long document's card appears once enough of it has
  been written to keep. To get a short one anyway, say "artifact" in your
  message; its card then appears when it is saved.

Other code blocks are not affected. Artifacts work with every model: models
without tools write a code block and OCI saves it once the reply is finished.

## Watching an artifact being written

When a model that can use tools writes an artifact, the reply shows its card
straight away, below the reply's work block (see
[Conversations](conversations.md#how-a-reply-shows-the-models-work)) and
above its answer, while the block's heading reads **Writing *Title*…**:

- **Preparing *Title*…** until the first text arrives. Some providers send the
  whole artifact at once at the end; after a few seconds the card shows how
  long it has been waiting.
- **Writing *Title*…** with the number of lines and characters so far and the
  last few lines, growing as the model writes. A revision shows
  **Revising *Title*… (2 changes)**.
- Once the artifact is saved, the card becomes the ordinary card that opens it.

Select the small arrow at the right edge of a card (**Show details for
*Title*** to a screen reader) to open the details inside the card: the title,
kind and size, each change of a revision as a before-and-after snippet, the
latest source while it is being written, and **Open artifact (version *N*)**
for the version that call made. Selecting the rest of the card still opens
the artifact. In the expanded work block the same call is one line, such as
**Created artifact 'Title'**; select it to jump to the card. A call that
failed has no card; its line in the work block opens the same details and
the error.

On a wide screen (a computer, or a tablet held sideways) the artifact panel
**opens by itself** beside the conversation for the first artifact a reply
starts writing, and shows the source as it arrives, following the end unless
you scroll up. When the artifact is saved, the panel switches to its preview,
unless you have opened something else in the meantime. If the reply puts a
page, image or diagram in a code block instead, the panel opens on it once the
reply has finished. The panel never takes focus from what you are doing: you
can keep typing in the message box. Screen readers announce "Opened artifact:
*Title*" and when the writing starts and finishes.

The panel does not open by itself:

- on phones and narrow windows (select the card to watch instead);
- for conversations you open from history, or after reloading the page;
- again in the same reply after you have closed it;
- if you turn off **Open artifacts automatically** in Settings → Customisation.

Share links never open artifacts by themselves.

If you reload the page while a reply is still writing an artifact, the panel
and card pick up where it is: you see what has been written so far, and the
rest as it arrives. This works however long the artifact is (since v0.10;
before, a very long one could stop with "Live replay is no longer
available").

## Opening an artifact

An artifact appears in the reply as a card with its title, its kind and its
version. Select it to open the artifact panel. On a wide screen the panel sits
beside the conversation, which narrows to make room; the conversation and the
message box stay usable, and Tab moves between them and the panel. On a phone
the panel fills the screen until you close it.

The panel has three views:

- **Preview** shows the artifact: the page or image itself, the drawn diagram,
  or the formatted document.
- **Source** shows the text it is made of, with the same syntax colouring as
  code in replies (and your **Wrap Long Code Lines** choice). Very large
  sources are shown without colouring so the page stays responsive.
- **Versions** lists every version, newest first, with who made it and when.
  Select one to look at it.

**Copy** puts the version you are looking at on the clipboard; **Download**
saves it as a file (`.html`, `.svg`, `.mmd` or `.md`). For documents,
**Export as…** saves the version as a Word document, PDF, presentation or
spreadsheet ([Exporting as files](exporting.md)). Press Escape (with focus in
the panel) or select Close to go back to the conversation. After clicking
inside a preview, press Tab to move out of it first: the preview is sealed off
from the rest of OCI, so it does not pass on key presses.

### Making the panel wider or narrower

On a wide screen, drag the panel's left edge to make it wider or narrower: at
least 22rem (about 350 pixels) and at most 70% of the window.
With the keyboard, Tab to the edge (**Resize artifact panel**) and use the
left and right arrow keys (Shift for bigger steps); Home makes it as narrow as
it goes and End as wide. Double-click the edge, or press Enter on it, to go
back to the usual width. The width you choose is remembered in this browser
for every conversation; in a smaller window the panel never takes more than
70% of it. Full screen and phones are not affected.

### Full screen

Select **Full screen** (the arrows beside Close) to give the artifact the whole
window, over the sidebar and the top bar. It works from the panel beside the
conversation, on a phone and on share links, and the preview, source and
versions all use the extra room. While the artifact is full screen, the
conversation behind it is out of reach: Tab moves only between the panel's
controls, and screen readers treat it as a dialog. Select **Exit full screen**
or press Escape to go back to the panel as it was; a second Escape closes the
panel. (If you are editing a document, the first Escape leaves the edit.)

Full screen is only ever your choice. Closing the panel or opening another
artifact ends it, a panel that opens by itself never starts full screen, and a
reply that starts writing an artifact does not replace the one you are viewing
full screen.

Open artifacts from their cards. If a reply's text links to an artifact, or to
anything else OCI cannot open, the link shows as plain text.

## Changing an artifact

Every change makes a new version; earlier versions are kept.

- **Documents** (Markdown) can be edited directly: open the document, select
  **Edit**, change the text and select **Save as new version** (or press
  Ctrl+Enter, ⌘+Enter on a Mac). If the document changed while you were
  editing, OCI tells you instead of overwriting the newer version.
- **HTML, SVG and diagrams** are changed by asking the model, for example
  "make the chart's bars blue". A model that can use tools revises the existing
  artifact, and the reply shows its card marked *Updated · HTML · version 3*.
  Other models write a new version as a new code block, which becomes a new
  artifact.

## Safety

HTML and SVG artifacts can contain scripts, so OCI runs them in a sealed frame.
Inside it a page can draw, animate and respond to clicks, but it cannot:

- see or use your OCI session, cookies, stored data or the rest of the page;
- connect to the internet, or load anything from it: images, fonts and scripts
  must be included in the artifact itself;
- open new windows or tabs, or take you to another page.

For charts, models can ask OCI to include a charting library
([D3](https://d3js.org)) in the frame; it comes from OCI itself, never from the
internet. A page that tries to load something from elsewhere simply shows
without it.

## Sharing, exporting and deleting

- **Share links** include the artifacts of the shared replies, at the version
  that was current for them, and open them in the same sealed frame. Viewers
  can open, copy and download them but not see other versions.
- **Exports**: the full export (Settings → Your data) includes every artifact
  with all its versions in each conversation's JSON file; the Markdown files
  and a single conversation's Markdown download name them, with the version
  each reply made and, when there is a newer one, the latest version.
- **Storage**: artifacts count towards your storage allowance (each version
  counts). Moving a conversation to the trash frees that space; restoring it
  needs room for it again.
- **Deleting** a conversation deletes its artifacts with it, and they follow
  the conversation's retention. Forking or editing a conversation copies the
  artifacts of the copied replies.

## If you do not see artifacts

Your administrator can switch artifacts off for your role. Code blocks then
appear as ordinary code blocks, and models are not offered the artifact tools.
Artifacts you already have stay readable.
