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
- **Documents and anything else a model creates on purpose.** Models that can
  use tools can create an artifact directly, including Markdown documents, and
  revise it later.

Other code blocks are not affected. Artifacts work with every model: models
without tools write a code block and OCI saves it once the reply is finished.

## Opening an artifact

An artifact appears in the reply as a card with its title, its kind and its
version. Select it to open the artifact panel. On a computer the panel opens on
the right of the conversation; on a phone it fills the screen.

The panel has three views:

- **Preview** shows the artifact: the page or image itself, the drawn diagram,
  or the formatted document.
- **Source** shows the text it is made of.
- **Versions** lists every version, newest first, with who made it and when.
  Select one to look at it.

**Copy** puts the version you are looking at on the clipboard; **Download**
saves it as a file (`.html`, `.svg`, `.mmd` or `.md`). For documents,
**Export as…** saves the version as a Word document, PDF, presentation or
spreadsheet ([Exporting as files](exporting.md)). Press Escape or select
Close to go back to the conversation. After clicking inside a preview, press
Tab to move out of it first: the preview is sealed off from the rest of OCI,
so it does not pass on key presses.

## Changing an artifact

Every change makes a new version; earlier versions are kept.

- **Documents** (Markdown) can be edited directly: open the document, select
  **Edit**, change the text and select **Save as new version** (or press
  Ctrl+Enter, ⌘+Enter on a Mac). If the document changed while you were
  editing, OCI tells you instead of overwriting the newer version.
- **HTML, SVG and diagrams** are changed by asking the model, for example
  "make the chart's bars blue". A model that can use tools revises the existing
  artifact, and the reply shows a step such as *Updated artifact 'Sales chart' ·
  version 3* with a card to open it. Other models write a new version as a new
  code block, which becomes a new artifact.

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
  and a single conversation's Markdown download name them.
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
