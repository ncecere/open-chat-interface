# Third-party notices

Open Chat Interface is available under the [MIT License](LICENSE). Most
dependencies are installed from npm under their own licences, which `pnpm
licenses:check` keeps to an approved list. This file records the third-party
material the published images carry that is not code under a permissive
software licence.

## Fonts for PDF export (API image)

PDF export (v0.10) embeds subsets of these fonts in documents with text
outside Windows-1252. They are installed from the Fontsource packages named
below, and the API image keeps only the faces PDF export uses (about 10 MB;
`apps/api/scripts/prune-pdf-fonts.mjs`). Each package's full licence text
ships with it (`node_modules/@fontsource/<package>/LICENSE`).

All are licensed under the [SIL Open Font License, Version
1.1](https://openfontlicense.org/open-font-license-official-text/) (OFL-1.1).
The OFL permits embedding the fonts in documents and bundling them with
software; the fonts themselves may not be sold on their own, and modified
versions may not use the reserved font names.

| Font | Package | Copyright |
| --- | --- | --- |
| Noto Sans (Latin, Greek, Cyrillic, Vietnamese, Devanagari) | `@fontsource/noto-sans` 5.3.0 | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic) |
| Noto Sans Arabic (also used for arrows, maths and symbols) | `@fontsource/noto-sans-arabic` 5.3.0 | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/arabic) |
| Noto Sans Hebrew | `@fontsource/noto-sans-hebrew` 5.3.0 | Copyright 2024 The Noto Project Authors (https://github.com/notofonts/hebrew) |
| Noto Sans SC (Chinese) | `@fontsource/noto-sans-sc` 5.3.0 | Google Inc. |
| Noto Sans JP (Japanese) | `@fontsource/noto-sans-jp` 5.3.0 | Google Inc. |
| Noto Sans KR (Korean) | `@fontsource/noto-sans-kr` 5.3.0 | Google Inc. |

## Model logos (web image)

Third-party model logos retain their upstream notices in
`apps/web/public/logos/`.
