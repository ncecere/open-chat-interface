# Exporting replies and documents as files

You can save a reply, or a document [artifact](artifacts.md), as a Word
document, a PDF, a presentation or a spreadsheet. OCI makes the file from the
saved text, so what you get matches what the reply says, laid out for that
format.

## How to export

- **A reply:** below the reply, select **Export as…** (the file icon next to
  Copy) and choose a format. On a computer the reply's buttons appear when you
  point at or move into the reply; on a phone they are always shown.
- **A document artifact:** open it and select **Export as…** in the panel. You
  get the version you are looking at, so open an older one under **Versions**
  first to export that. HTML pages, SVG images and diagrams are not converted:
  use **Download** to save them as they are.

The menu works with the keyboard: Enter or the arrow keys open it, the arrow
keys move between formats, Enter chooses one and Escape closes it. The file
downloads as soon as it is ready, usually within a few seconds. If it cannot be
made, the reason appears under the button instead.

Export is not offered while a reply is still being written, for replies with no
text, or on share links.

## Formats

| Format | What you get |
| --- | --- |
| **Word document** (`.docx`) | The conversation's (or document's) title, then the content with real Word headings, bulleted and numbered lists, tables with a shaded header row that repeats on each page, and code in a monospace font. A4 pages. |
| **PDF** (`.pdf`) | The same content on A4 pages, in Helvetica and Courier. Long tables and code continue over pages. Fonts are limited; see [Characters in PDFs](#characters-in-pdfs). |
| **Presentation** (`.pptx`) | A widescreen deck: a title slide, then one slide per top-level heading (or per second-level heading when there is only one top-level heading). Paragraphs and list items become bullets; tables become slide tables. A slide that would overflow continues on the next one, marked "(continued)". |
| **Spreadsheet** (`.xlsx`) | One worksheet per table, named after the heading above it (or "Table 1", "Table 2", …). The header row is bold and stays in view as you scroll. Plain numbers and percentages are stored as numbers; everything else, including values such as `007` or `=SUM(A1)`, stays text. Offered only when the reply or document contains a table. |

Files are named after the conversation and the day for a reply
(`quarterly-plan-reply-2026-10-02.docx`), and after the title and version for a
document (`project-plan-v3.pdf`).

## What is kept

- Headings, paragraphs, **bold**, *italic*, ~~strikethrough~~ and `inline code`.
- Bulleted and numbered lists, including nested lists and the number a list
  starts at.
- Tables, with their column alignment. In Word documents, PDFs and
  presentations a long table repeats its header row on each new page or slide.
- Code blocks, in a monospace font (without colour highlighting).
- Block quotes, and horizontal rules (except in presentations, which leave
  rules out).
- Links to web addresses (`http`, `https`) and email addresses (`mailto`) stay
  clickable. Other links keep their text but are not links.

## What is not

- **Images** are never downloaded into the file. An image shows as its
  description, for example "[Image: Sales by region]".
- **Maths** stays as written, for example `$x^2$`, rather than being typeset.
- **Diagrams and HTML** in a reply appear as their source code. Open the
  artifact to see or download the drawing or page.
- **HTML tags** in the text appear as text.
- **Web search sources, reasoning and tool steps** are not part of the reply's
  text and are left out. To keep the whole conversation, download it as
  Markdown from the top of the conversation, or use
  [Your data](your-data.md#exporting-everything).

### Characters in PDFs

PDFs use the standard PDF fonts, which cover Western European text (the
Windows-1252 character set) only:

- Accented letters outside that set are written without their accent
  ("ő" becomes "o").
- A few symbols get plain stand-ins: arrows such as "→" become "->", and "≤",
  "≥" and "≠" become "<=", ">=" and "!=".
- Anything else, including Greek, Cyrillic, Chinese, Japanese, Korean,
  Arabic, Hebrew and emoji, prints as "?".

For text in other scripts, export a **Word document** instead: it keeps every
character.

## Limits

- The reply or document can be up to 512 KB of text, and the file up to 20 MB.
- Very long or complex content can take too long to lay out; OCI then says so,
  and a shorter part or another format usually works. A presentation can have
  at most 250 slides, and a table cell on a slide shows at most 500 characters.
- File exports and single-conversation Markdown downloads share an allowance of
  60 per hour. When it is used up, OCI tells you to try again later.
- One file is prepared at a time for you. If several people are exporting at
  once, you may be asked to try again in a moment.

Every export is recorded in the instance's audit log with its format and size,
but not its content.
