# Settings

Reach settings from your name at the bottom of the sidebar.

The sections are tabs across the top. Where they do not fit on one row, for
example on a phone, a **Settings section** menu takes their place.

A section with nothing in it for you is left out: **Memory** when your
administrator has not made memory available to you and you have no saved
notes, and **Connectors** when there is nothing for your role to connect.
Their addresses still open if you follow a link to one.

## Account

![Account settings](../images/user-settings-account.png)

Your name, email address, role, and how you sign in.

- **Name.** If you sign in with an email address and password, **Edit** changes
  the name shown on this instance (1 to 100 characters). If you sign in through
  your organisation, your name and email address come from there and are
  marked as such.
- **Password.** **Change Password** asks for your current password and a new
  one of at least 12 characters. **Sign out of all other devices** is ticked by
  default, so a change made after losing a device locks it out; you stay
  signed in where you made the change. If you sign in through your
  organisation, your password is managed there instead. If your administrator
  has turned off email and password sign-in, the page says so and the password
  cannot be changed.
- **Devices.** **View Devices** lists where your account is signed in: the
  browser and system, a shortened network address, when each signed in, and
  when it was last active. Your current device is marked **This device**.
  **Sign out** ends one other session; **Sign out all other devices** ends
  every session but this one. A device you sign out can stay signed in for up
  to five minutes.

You cannot change your email address or delete your account yourself. To delete
your account, contact your administrator.

## Customisation

![Customisation settings](../images/user-settings-customization.png)

What you set at the top is sent with every message, which is why it changes
replies without you repeating yourself.

- **What to call you** — used when a reply addresses you directly.
- **What you do** — saves explaining your field every time. "Research
  administrator" produces different examples from "undergraduate".
- **Traits** — how replies should read. "Concise" is the one most people want
  and few think to ask for.
- **Anything else** — free text. Format preferences belong here: "answer in
  bullet points", "always show your working", "British spelling".

Being specific pays off more than being thorough. Three precise sentences beat a
paragraph of generalities. **Save Preferences** becomes available once you have
changed something.

Further down are choices about the interface itself, all kept in this browser:

- **Appearance** — **Light**, **Dark**, or **System** to follow your device.
  The same choice is in the appearance menu at the top of a conversation and
  of Settings.
- **Invert Send/New Line Behavior** — normally `Enter` sends a message and
  `Shift + Enter` starts a new line. With this on, `Enter` starts a new line
  and `Cmd/Ctrl + Enter` sends. When you edit a message you have sent,
  `Enter` always starts a new line and `Cmd/Ctrl + Enter` submits.
- **Wrap Long Code Lines** — wraps code instead of scrolling it sideways.
- **Open artifacts automatically** (on by default) — opens the artifact panel
  beside the conversation when a reply starts writing a page, image, diagram
  or document, so you can watch it being written. It applies on wide screens
  only; see [Artifacts](artifacts.md).

## History

![History](../images/user-settings-history.png)

Your conversations, under **Active**, **Archived** and **Trash**, newest
activity first.

- Each title opens its conversation. A conversation in a project shows the
  project's name.
- **Search titles** narrows the list to conversations whose title contains what
  you type. To search what was said in them, use the sidebar's search; see
  [Finding a conversation](conversations.md#finding-a-conversation).
- The list shows 50 conversations at a time; **Load more** adds the next 50.
- Tick conversations, or use **Select all** to tick everything listed, then
  **Archive** or **Delete** them. Deleting moves them to the trash, where they
  stay recoverable until their deletion date.

Two buttons at the top handle all of your data at once:
**Export all conversations** downloads your conversations and files, and
**Import from ChatGPT or Claude** brings history in from those services. An
import carries on if you close its window. See [Your data](your-data.md).

## Memory

Your own switch for memory, and every note OCI keeps about you, to add, edit
and delete. See [Memory](memory.md).

## Models

![The models available to you](../images/user-settings-models.png)

Which models you can use, and what each can do. This mirrors the picker, with
room to read the descriptions properly.

You cannot add models here. Which appear is decided by your administrator, and
may depend on your role.

## Connectors

Services that need your own sign-in before models can use their tools, with
**Connect** and **Disconnect**. See [Connectors](connectors.md).

## Attachments

![Your attachments](../images/user-settings-attachments.png)

Everything you have uploaded, in chats and to [projects](projects.md), and how
much space it occupies. **Storage used** shows the total against any limit for
your role, broken down into chat files, project files and artifacts.

Delete chat files you no longer need: this is what frees space against a
storage limit. Deleting a file removes it from its conversations, which stay,
and models can no longer read it there. Project files show the project they
belong to; open the project to delete them.

## Keyboard shortcuts and help

Every settings page shows your usage limits, a **Keyboard Shortcuts** card and
a **Need help?** card: beside the page on a wide screen, below it on a narrow
one. The send and new-line keys in the card follow **Invert Send/New Line
Behavior**, and the card shows `⌘` on a Mac and `Ctrl` everywhere else. The
shortcuts worth learning:

| Shortcut | Does |
| --- | --- |
| `Cmd/Ctrl + K` | Search and commands |
| `Cmd/Ctrl + Shift + O` | New conversation |
| `Cmd/Ctrl + B` | Show or hide the sidebar |
| `Cmd/Ctrl + /` | Open the model picker, with its search ready for typing |
| `Enter` | Send the message (`Cmd/Ctrl + Enter` when inverted) |
| `Shift + Enter` | Start a new line (`Enter` when inverted) |

The first four work anywhere in the chat — a new chat, a conversation or a
project, though not in Settings or Admin — including while you are typing a
message, but not while an input method is composing text. Use `Cmd` on a Mac
and `Ctrl` elsewhere. `Cmd/Ctrl + /` needs a message box with a model picker (a
new chat or a conversation) and does nothing elsewhere.
Search (`Cmd/Ctrl + K`) lists the same shortcuts beside **New chat** and the
sidebar command.

For help with your account, contact the administrator who runs your instance.
