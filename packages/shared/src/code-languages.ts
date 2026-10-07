/**
 * The languages of code artifacts (#298). A person who asks for a script "as
 * an artifact" gets it as code in its own language: shown as code, labelled
 * "Python", downloaded as `.py`. Before, the only kinds were HTML, SVG,
 * Mermaid and Markdown, so the model wrapped the script in an HTML page.
 *
 * Names follow Shiki's language ids, which the source view highlights with;
 * an unknown language is kept as given and downloads as `.txt`.
 */
interface CodeLanguage {
  label: string;
  extension: string;
}

const CODE_LANGUAGES: Record<string, CodeLanguage> = {
  bash: { label: 'Bash', extension: 'sh' },
  c: { label: 'C', extension: 'c' },
  cpp: { label: 'C++', extension: 'cpp' },
  csharp: { label: 'C#', extension: 'cs' },
  css: { label: 'CSS', extension: 'css' },
  dart: { label: 'Dart', extension: 'dart' },
  dockerfile: { label: 'Dockerfile', extension: 'dockerfile' },
  elixir: { label: 'Elixir', extension: 'ex' },
  go: { label: 'Go', extension: 'go' },
  graphql: { label: 'GraphQL', extension: 'graphql' },
  haskell: { label: 'Haskell', extension: 'hs' },
  html: { label: 'HTML', extension: 'html' },
  java: { label: 'Java', extension: 'java' },
  javascript: { label: 'JavaScript', extension: 'js' },
  json: { label: 'JSON', extension: 'json' },
  julia: { label: 'Julia', extension: 'jl' },
  jsx: { label: 'JSX', extension: 'jsx' },
  kotlin: { label: 'Kotlin', extension: 'kt' },
  latex: { label: 'LaTeX', extension: 'tex' },
  lua: { label: 'Lua', extension: 'lua' },
  makefile: { label: 'Makefile', extension: 'mk' },
  matlab: { label: 'MATLAB', extension: 'm' },
  perl: { label: 'Perl', extension: 'pl' },
  php: { label: 'PHP', extension: 'php' },
  powershell: { label: 'PowerShell', extension: 'ps1' },
  python: { label: 'Python', extension: 'py' },
  r: { label: 'R', extension: 'r' },
  ruby: { label: 'Ruby', extension: 'rb' },
  rust: { label: 'Rust', extension: 'rs' },
  scala: { label: 'Scala', extension: 'scala' },
  sql: { label: 'SQL', extension: 'sql' },
  swift: { label: 'Swift', extension: 'swift' },
  toml: { label: 'TOML', extension: 'toml' },
  tsx: { label: 'TSX', extension: 'tsx' },
  typescript: { label: 'TypeScript', extension: 'ts' },
  xml: { label: 'XML', extension: 'xml' },
  yaml: { label: 'YAML', extension: 'yaml' },
};

const ALIASES: Record<string, string> = {
  'c#': 'csharp',
  'c++': 'cpp',
  cs: 'csharp',
  golang: 'go',
  js: 'javascript',
  node: 'javascript',
  ps1: 'powershell',
  py: 'python',
  python3: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  ts: 'typescript',
  yml: 'yaml',
  zsh: 'bash',
};

/** Longest language name stored; the database checks the same. */
export const MAX_CODE_LANGUAGE_LENGTH = 32;

/**
 * A language as stored: lower case, aliases resolved (`py` is `python`).
 * Anything that is not a plain name (spaces, punctuation beyond `+#.-_`) is
 * `text`.
 */
export function normalizeCodeLanguage(value: string | null | undefined): string {
  const name = (value ?? '').trim().toLowerCase();
  const resolved = ALIASES[name] ?? name;
  return new RegExp(`^[a-z0-9][a-z0-9+#._-]{0,${MAX_CODE_LANGUAGE_LENGTH - 1}}$`).test(resolved)
    ? resolved
    : 'text';
}

/** How a language is named and saved: "Python" and `.py`; unknown ones as given and `.txt`. */
export function codeLanguageInfo(language: string | null | undefined): CodeLanguage {
  const name = normalizeCodeLanguage(language);
  return CODE_LANGUAGES[name] ?? { label: name === 'text' ? 'Code' : name, extension: 'txt' };
}
