# T3 Chat Replication Design Document

**Status:** Reverse-engineering reference  
**Source:** Authenticated, non-source-code browser exploration of `https://t3.chat/`  
**Capture viewport:** Desktop `1720 × 1323`; mobile `390 × 844`  
**Evidence:** 108 PNG screenshots plus accessibility snapshots in [`screen_shots/`](./screen_shots/)

> **Privacy warning:** The captures were made from an authenticated account. Several screenshots include a name, email address, profile image, thread titles, generated content, usage limits, attachments, and share metadata. Do not publish this folder without redacting it.

## 1. Purpose

This document specifies the product structure, visual language, interaction patterns, responsive behavior, and implementation architecture needed to build a close functional replica of T3 Chat.

The target is not a pixel-for-pixel asset clone. It is a faithful reconstruction of the experience:

- Multi-model AI chat with model discovery and per-message model selection
- Search, reasoning-effort, attachments, temporary chats, branching, retry, sharing, and code rendering
- A separate image-generation Canvas
- Multiple user profiles with independent settings and threads
- Full account, customization, history, model, API-key, attachment, shortcut, and support settings
- Desktop and compact mobile layouts

## 2. Product Architecture and Routes

### 2.1 Observed route map

| Route | Purpose |
|---|---|
| `/` | New-chat landing state |
| `/chat/:threadId` | Existing conversation |
| `/canvas` | Image generation workspace and generation history |
| `/settings/subscription` | Account, plan, billing, security, and devices |
| `/settings/customization` | Profile prompts, behavior, appearance, fonts, and density |
| `/settings/history` | Chat history, shared threads, import/export, and archive |
| `/settings/models` | Model catalog, filters, favorites, list/grid views |
| `/settings/models/:modelSlug` | Model details and benchmark card |
| `/settings/api-keys` | Bring-your-own-key provider configuration |
| `/settings/attachments` | Chat and Canvas attachment management |
| `/settings/shortcuts` | Keyboard shortcut recorder |
| `/settings/contact` | Support and external resource links |
| External feedback board | Feature requests and bug reports |

### 2.2 Recommended application modules

```text
AppShell
├── ChatWorkspace
│   ├── ThreadSidebar
│   ├── NewChatLanding
│   ├── ConversationView
│   ├── MessageRenderer
│   ├── ReasoningPanel
│   ├── Composer
│   ├── ModelPicker
│   └── ShareDialog
├── CanvasWorkspace
│   ├── CanvasControls
│   ├── GenerationGrid
│   └── GenerationTimeline
└── SettingsShell
    ├── SettingsIdentityRail
    ├── SettingsNavigation
    └── SettingsSection
```

## 3. Visual System

The values below are implementation approximations inferred visually. Treat them as starting tokens and tune against the screenshots.

### 3.1 Color tokens

#### Default dark theme

| Token | Approximation | Use |
|---|---:|---|
| `--bg-root` | `#17141D` | Main application background |
| `--bg-root-alt` | `#1D1922` | Subtle central surface/gradient stop |
| `--bg-sidebar` | `#12090F` | Sidebar base |
| `--bg-elevated` | `#0E090D` | Menus and dark popovers |
| `--bg-control` | `#27212D` | Inputs, composer, segmented controls |
| `--bg-control-hover` | `#322838` | Hover/active neutral surface |
| `--border-subtle` | `rgba(222, 185, 215, .12)` | Dividers and card borders |
| `--border-strong` | `rgba(229, 159, 210, .22)` | Inputs and elevated cards |
| `--accent` | `#C0005B` | Primary buttons and selected controls |
| `--accent-bright` | `#D00065` | High-emphasis hover/focus |
| `--accent-soft` | `rgba(192, 0, 91, .18)` | Selected rows and accent washes |
| `--text-primary` | `#F5F1F5` | Headings and primary copy |
| `--text-secondary` | `#C9C0CE` | Body copy |
| `--text-muted` | `#857B8A` | Metadata and disabled content |
| `--success-cost` | `#00C990` | Low/medium model cost markers |
| `--warning` | `#FFB000` | New-model banners and stars |
| `--danger` | `#9B1527` | Destructive actions |

The default theme uses a very subtle plum/magenta atmospheric gradient, especially along the sidebar and edges. Large surfaces are almost flat; depth comes from one-pixel borders, light tonal changes, and restrained shadows.

#### Light theme

- Root is near-white with a pink-lavender wash.
- Primary text changes to deep plum rather than pure black.
- Accent pink becomes more prominent in borders and text.
- Cards remain translucent and low-contrast rather than becoming stark white.
- See `35-home-light-theme.png`.

#### Boring mode

Boring mode keeps the dark layout but removes most magenta coloration, shifting borders and fills toward neutral charcoal. Accent usage remains only where needed for state. See `45-boring-mode.png`.

### 3.2 Typography

Observed customization choices reveal the intended fonts:

- **Main UI:** Proxima Vara (default)
- **Code:** Berkeley Mono (default)
- Alternate text fonts: Atkinson Hyperlegible, OpenDyslexic, System Font

Recommended scale:

| Style | Size / line height | Weight |
|---|---|---|
| Display greeting | `30px / 1.15` | 650–700 |
| Page title | `26px / 1.2` | 650–700 |
| Section title | `22px / 1.25` | 650–700 |
| Card title | `16px / 1.3` | 600 |
| Body/chat | `15–16px / 1.65` | 400–500 |
| Control | `13–14px / 1.2` | 500–600 |
| Metadata | `11–12px / 1.35` | 400–500 |
| Code | `13–14px / 1.55` | 400 |

### 3.3 Spacing, shape, and depth

- Base spacing unit: **4px**
- Common gaps: 8, 12, 16, 24, 32px
- Desktop sidebar: approximately **256px** wide
- Main chat content: approximately **720–760px** wide
- Settings content column: approximately **850px** wide, plus a **240px** identity rail
- Input/control height: 36–40px
- Primary button height: 36–40px
- Composer radius: 12–16px
- Cards: 8–12px radius
- Pills/chips: fully rounded or 8–10px radius
- Shadows are dark and broad but faint; borders do most separation work.
- Focus/selection uses pink borders and soft glow, not large shadows.

### 3.4 Iconography

Use a consistent 16–20px outline icon set. Icons carry substantial meaning:

- Sidebar, search, new chat, Canvas
- Search grounding, attachment, effort/reasoning, temporary mode
- Pin, archive, branch, retry, edit, copy, share
- Model capabilities: fast, vision, reasoning, effort control, tool calling, image generation, PDF comprehension

Provider logos are monochrome and sit in a compact vertical rail inside the model picker.

## 4. Desktop Application Shell

### 4.1 Sidebar

The expanded sidebar is fixed at roughly 256px and contains:

1. Header row: sidebar toggle, T3 Chat wordmark, Canvas shortcut
2. Full-width pink `New Chat` button
3. Thread search input
4. Grouped thread list (`Pinned`, `Today`, `Older`)
5. Hover-only thread actions: pin/unpin and archive
6. Bottom profile controls: avatar/user menu and new-profile icon

Thread titles support inline editing by double-click. Pinned child/branch relationships use a small branch glyph.

The collapsed desktop state becomes a small top-left pill containing sidebar, search, and new-thread controls. The main content expands to use the available width.

### 4.2 Global top-right controls

A rounded corner cluster contains:

- Temporary-chat toggle (clock-like icon)
- Theme/settings menu
- On existing threads, share may appear nearby

The settings popover includes light/system/dark theme choices, Boring Mode, and a link to full settings.

## 5. New Chat Experience

### 5.1 Landing content

The desktop landing state is centered in the upper-middle region:

- Personalized heading: “How can I help you, [name]?”
- Four category pills: Create, Explore, Code, Learn
- Four suggestion rows separated by hairline dividers

Selecting a category does not navigate; it updates the suggestion rows and applies a solid pink selected state.

Observed categories:

- **Create:** writing, stories, character and prompt ideas
- **Explore:** books, rankings, companies, pricing questions
- **Code:** programming tasks and technical explanations
- **Learn:** educational and conceptual prompts

### 5.2 Composer

The desktop composer is a bottom-anchored, centered card approximately 750px wide:

- Large multiline textarea on top; it grows vertically as lines are added
- Bottom toolbar with model selector, effort selector, search grounding, and attachment
- Square send button aligned bottom-right
- Disabled send state when textarea is empty and accented enabled state when text is present

The model name includes a color-coded cost indicator (`$`, `$$`, `$$$`, `$$$+`, or BYOK).

### 5.3 Temporary chat

Temporary mode:

- Replaces the personalized heading with “Temporary chat” and a clock icon
- Highlights the top-right temporary control
- Retains model, effort, search, and attachment controls
- Should avoid persisting the resulting thread to normal history

## 6. Model Picker and Inference Controls

### 6.1 Model picker

The picker opens upward from the composer and includes:

- Search field
- Capability filter button
- Vertical provider/favorites rail
- Scrollable model list
- Model rows with provider icon, name, cost, short description, favorite star, capability badges, and info action

The picker supports provider filtering and favorites. The capability filter menu contains:

- Fast
- Vision
- Reasoning
- Effort Control
- Tool Calling
- Image Generation
- PDF Comprehension
- Combined-results behavior

### 6.2 Reasoning effort

A compact menu offers:

- Instant
- Low
- Medium
- High

The active value is displayed in the composer. Different models expose different supported levels.

### 6.3 Search grounding

Search grounding is a toggle-like composer action. For higher-cost models, first enablement displays a warning dialog explaining increased usage. The dialog has `Cancel` and strong-accent `Enable search` actions.

When active, the Search pill becomes accented and displays the configured search count (for example `x1`). Search execution uses the normal response streaming surface:

- Centered three-dot loading indicator while the model is searching
- Stop-generation square in the composer
- Completed `Searched the web` disclosure above the answer
- Expandable result list with favicon/provider mark, page title, and URL
- Inline source links rendered in accent pink
- Expandable Search Grounding Details containing the generated search query and result set

See `90-web-search-enabled-composer.png` through `94-web-search-grounding-details.png`.

### 6.4 Attachments

Desktop presents an explicit Attach pill. Mobile moves attachment into the composer’s `+` options menu.

Attachment behavior:

- Uploads render as chips above the textarea.
- In-progress chips show a percentage and progress underline.
- Completed image attachments use a thumbnail; text/PDF files use type-specific icons and filenames.
- Multiple files can be attached to one message.
- Sent user bubbles preserve the attachment cards beside the prompt.
- The assistant can jointly inspect an image and Markdown document, or extract structured content from a PDF.
- Uploaded files appear in Settings → Attachments with MIME type, creation date, open action, selection, and delete action.

Test fixtures are stored under `screen_shots/fixtures/`. See `95-attachments-uploaded-composer.png` through `104-attachment-manager-pdf-filter.png`.

## 7. Conversation and Message Rendering

### 7.1 Layout

- User messages are right-aligned in a muted rounded bubble.
- Assistant messages are primarily unboxed flowing content in the central column.
- The composer stays anchored at the bottom.
- Thread-level share and settings controls remain top-right.

### 7.2 Rich content

The renderer must support:

- Paragraphs and headings
- Ordered/unordered lists with pink bullets/numbers
- Inline emphasis
- Inline math and displayed fractions
- Syntax-highlighted code blocks
- Horizontal rules/thematic breaks
- Attachments and images

Code blocks use:

- Dark body and a slightly lighter header strip
- Language label at left
- Download, wrap, and copy actions at right
- Berkeley Mono
- Horizontal scrolling when wrapping is disabled

### 7.3 Reasoning panel

Reasoning-capable models add a collapsible section above the final answer:

- Brain/reasoning icon and `Reasoning` disclosure button
- Expanded content in a slightly lighter dark card
- Structured headings and paragraphs
- Disclaimer that models may hide or summarize parts of their thinking

### 7.4 Message actions

User message actions:

- Retry with selected model
- Branch from message
- Edit
- Copy
- Message options menu

Assistant message actions:

- Copy response
- Branch
- Retry
- Model/effort attribution appears alongside actions on hover

Branching should create a linked child thread and preserve parent navigation.

### 7.5 Three-model comparison captured

The same formatting prompt was sent to:

1. Claude Sonnet 4.6 — `57-model-response-claude-sonnet-4-6.png`
2. Gemini 3.6 Flash — `58-model-response-gemini-3-6-flash.png`
3. GPT-5.6 Sol — `59-model-response-gpt-5-6-sol.png`

All three use the same presentation system. Variations come from answer length, math formatting, reasoning availability, and selected effort level. Gemini’s expanded reasoning is in `60-gemini-reasoning-expanded.png`.

## 8. Search and Command Menu

The top-left search opens a centered command palette with:

- Combined command/thread search input
- New Chat action
- Manage Chat History
- View All Available Models
- View All Uploaded Attachments
- Active profile and Create New Profile
- Keyboard hint footer

The overlay dims the application and uses a compact, high-contrast black/plum surface. Search results mix commands and matching thread titles. When no threads match, the palette retains a single “New chat with query” action instead of showing a dead-end empty state.

## 9. Profiles and User Menu

### 9.1 User menu

The avatar menu contains:

- User name and plan badge
- Expandable plan usage summary
- Settings
- Feedback
- Sign out

The expanded Pro summary displays Base and Burst usage bars and remaining/reset time.

### 9.2 Profile creation

Profile creation appears as a card attached to the bottom-left profile area rather than a central dialog:

- Icon chooser with a dense grid of outline icons
- Profile name field
- Copy settings from: Start from scratch or an existing profile
- Disabled Create Profile action until valid
- Cancel control

Profiles have separate settings and thread collections. Entering a valid profile name immediately enables the primary Create Profile action; no profile is created until that button is pressed.

## 10. Share Experience

The share dialog supports multiple public links and includes:

- `New Link`
- Existing link row with age and metrics
- Copy/share actions
- Auto-update toggle
- Include-attachments toggle
- Delete link
- Main Copy Link action

Sharing snapshots the current thread state. Auto-update keeps the share synchronized; existing forks are not modified. The resulting public route is a read-only conversation view with a sticky footer containing “Shared read-only view” and a `Continue chat` action.

## 11. Canvas Workspace

Canvas is a separate image-generation product inside the same shell.

### 11.1 Desktop layout

- Fixed 256px left control rail
- Large generation result area
- Grid/timeline view toggle at top-right
- Settings menu shared with Chat

Control rail sections:

1. Prompt textarea
2. Reference image upload
3. Model selection with active count
4. Current models and optional legacy models
5. Aspect ratios: 1:1, 16:9, 9:16, 4:3, 3:4, 21:9
6. Resolution: Standard 1K, High 2K, Ultra 4K
7. Bottom Generate button

### 11.2 Results

Grid view shows image cards with:

- Generated image
- Model name
- Generation time
- Estimated cost
- Selection checkbox
- Copy, download, and delete actions

Timeline view groups results by date and prompt, with output count and model metadata.

### 11.3 Multi-model upsell

Selecting multiple models on the Pro plan opens a centered “Unlock Concurrent Generations” modal with Continue with one model and Upgrade to Premier actions.

### 11.4 Mobile Canvas

- Main Canvas initially shows only results and top controls.
- Left controls become a full-width overlay drawer.
- The drawer remains scrollable with Generate anchored at the bottom.

## 12. Settings Shell

### 12.1 Desktop settings frame

Desktop settings use three columns:

- Left identity rail: profile photo, name, email, plan, usage, shortcuts
- Main content column
- Empty right breathing room

A horizontal segmented navigation bar spans the top of the main content.

### 12.2 Mobile settings frame

Mobile removes the identity rail and replaces horizontal tabs with a section combobox. Header contains Back to Chat, theme, and Sign out.

### 12.3 Account

- Free, Pro, Premier pricing cards
- Current plan and upgrade/downgrade actions
- Manage Billing & Invoices
- Email-receipt toggle
- Change Email dialog
- Device/session dialog
- Danger Zone with Delete Account

### 12.4 Customization

Profile instructions:

- Preferred name
- Occupation/role
- Personality traits with suggested chips
- Long-form personal context

Behavior:

- Disable external-link warning
- Invert send/newline behavior

Visual:

- Boring Theme
- Hide Personal Information
- Disable Thematic Breaks
- Stats for Nerds
- Minimalist command menu
- Main text font
- Code font
- Chat density: Standard or Compact
- Live font/density preview with user bubble, answer text, bullets, and code

### 12.5 History & Sync

- Paginated chat-history table with checkboxes
- Per-thread pinned state
- Overflow: Archive all, Export all, Import
- Archive overlay with empty state or archived rows
- Shared-thread table
- Batch selection and delete history controls

### 12.6 Models

- Search and capability filters
- List and grid layouts
- Favorites
- New-model banner
- Bulk Select recommended / Unselect all menu
- Model detail route with capabilities, provider/developer, knowledge cutoff, date added, description, benchmark score, deep link, and favorite action

### 12.7 API Keys

Provider cards for Anthropic, OpenAI, Google, and OpenRouter:

- Compatible-model chips
- Expand/collapse model list
- Masked key input
- Provider dashboard link
- Save action

Never return stored keys to the client after saving; show only provider-level configured status.

### 12.8 Attachments

Chat tab:

- File-type filter: All, Images, PDF Documents, Text Documents
- Select-all and per-row checkboxes
- Name/type/created columns
- Open attachment link
- Per-file delete
- Row selection reveals a contextual `Delete (n)` bulk action and indeterminate select-all state
- Pagination and Delete All Chat Attachments danger action

Canvas tab:

- Image and Created columns
- Empty state when there are no Canvas inputs

### 12.9 Shortcuts

Editable shortcut groups:

- Core Actions: Search, Toggle Sidebar, Open Model Picker, Delete Current Chat
- Navigation: New Chat, Previous Thread, Next Thread

The recorder displays keys as individual keyboard chips and provides a clear `×` action. App shortcuts are disabled while recording.

### 12.10 Contact Us

Large bordered action cards for:

- Feature ideas
- Non-critical bugs
- Account/billing support
- Community/Discord
- Privacy Policy
- Terms of Service

## 13. Responsive Behavior

### Desktop (`≥ 1024px`)

- Persistent 256px sidebar
- Centered max-width chat content
- Bottom-anchored composer
- Settings identity rail visible
- Canvas controls persistent

### Tablet (`768–1023px` recommendation)

- Sidebar collapses by default
- Settings identity rail may collapse above content
- Composer remains centered with 24px page gutters

### Mobile (`< 768px`, observed at 390px)

- Compact top bar with sidebar, search, new-chat, Chat/Canvas mode selector, temporary mode, and settings
- Greeting wraps to two lines
- Suggestion categories and rows are removed from the initial viewport
- Composer becomes a compact card with textarea, `+`, model, and send
- Effort/search/attachment move into the `+` popover
- Sidebar becomes a full-screen drawer with New Chat and avatar at the bottom
- Model picker expands over most of the viewport
- Settings navigation becomes a dropdown
- Canvas controls become a drawer

## 14. Accessibility Requirements

The observed accessibility tree is generally strong and should be preserved:

- Landmarks: main, navigation, regions, articles
- Explicit names for model selector, message input, search, attachment, temporary mode, and share
- `aria-expanded`, `aria-selected`, and switch checked state
- Conversation messages represented as articles
- Tables expose headers, rows, cells, and checkboxes
- Dialogs have headings and named Close actions
- Keyboard shortcuts are visible and configurable

Implementation requirements:

- All popovers and dialogs trap/follow focus correctly
- Escape closes the topmost overlay only
- 44px minimum mobile touch targets
- Visible keyboard focus ring using accent color
- Reduced-motion support
- Sufficient contrast in muted and disabled states
- Announce streaming start/completion and errors without reading every token

## 15. Suggested Data Model

```ts
type User = {
  id: string
  name: string
  email: string
  avatarUrl?: string
  plan: "free" | "pro" | "premier"
}

type Profile = {
  id: string
  userId: string
  name: string
  icon: string
  preferredName?: string
  occupation?: string
  traits: string[]
  context?: string
  settings: ProfileSettings
}

type Thread = {
  id: string
  profileId: string
  title: string
  parentThreadId?: string
  pinned: boolean
  archivedAt?: string
  temporary: boolean
  createdAt: string
  updatedAt: string
}

type Message = {
  id: string
  threadId: string
  role: "user" | "assistant" | "system"
  modelId?: string
  content: ContentBlock[]
  reasoningSummary?: ContentBlock[]
  effort?: "instant" | "low" | "medium" | "high"
  searchEnabled?: boolean
  attachments: AttachmentRef[]
  parentMessageId?: string
  createdAt: string
}

type Model = {
  id: string
  provider: string
  name: string
  description: string
  costTier: "very-low" | "low" | "medium" | "high" | "very-high" | "byok"
  capabilities: ModelCapability[]
  favorite: boolean
  enabled: boolean
}
```

Additional entities: `Attachment`, `CanvasGeneration`, `ShareLink`, `ApiKeyConfiguration`, `ShortcutBinding`, `UsageWindow`, and `DeviceSession`.

Recommended attachment states: `queued`, `uploading`, `processing`, `ready`, `failed`, and `removed`. Persist MIME type, display name, size, thumbnail/preview metadata, and message references separately from the binary object.

## 16. Recommended Front-End State

- **Server state:** users, profiles, models, threads, messages, attachments, usage, share links
- **URL state:** current thread, settings section, model detail
- **Persistent local preferences:** sidebar collapsed, theme, Boring Mode, selected default model, chat density
- **Draft state:** composer text, pending attachments, effort, search enabled
- **Transient overlay state:** model picker, command palette, menus, dialogs
- **Streaming state:** response status, partial content, reasoning availability, token/error status

## 17. Implementation Phases

### Phase 1 — Shell and static fidelity

- Theme tokens, fonts, icons
- Desktop/mobile shells
- Sidebar, landing page, composer
- Settings frame

### Phase 2 — Core chat

- Thread/message storage
- Streaming assistant responses
- Model selector and effort
- Markdown/math/code renderer
- Retry, edit, copy, and branch

### Phase 3 — Management features

- Search/command palette
- Profiles
- History/archive/import/export
- Sharing
- Attachments

### Phase 4 — Canvas

- Prompt/reference controls
- Model/aspect/resolution controls
- Grid/timeline results
- Generation metadata and file actions

### Phase 5 — Account and polish

- Subscription/billing integration
- BYOK vault
- Usage meters
- Shortcuts
- Accessibility and responsive QA

## 18. Out-of-Scope or Intentionally Unexecuted Actions

The exploration opened safe dialogs and generated test messages, but did not complete destructive or financial actions:

- Account deletion
- Thread/history/attachment deletion
- Archive-all or unselect-all bulk changes
- Plan upgrade/downgrade or billing portal changes
- API-key submission
- Email change confirmation
- Device logout
- Public feedback submission

These flows should use confirmation dialogs, explicit consequences, and idempotent server APIs.

## 19. Evidence Index

See [`screen_shots/README.md`](./screen_shots/README.md) for the complete screenshot catalog. Each interactive capture generally has a corresponding `*-elements.txt` accessibility snapshot.