/**
 * Scale profiles: how big the generated dataset is and how hard the load test
 * pushes. `large` is the size named in docs/dev/v0.11-design.md, section 10.
 * Row counts here are exact for the generated tables; passages (chunks) and
 * share links follow from them and are reported after generation.
 *
 * Load is stated as concurrent virtual users (VUs) per scenario, each one a
 * signed-in person, plus a sign-in arrival rate for the storm.
 */
export const PROFILES = {
  tiny: {
    dataset: {
      people: 50,
      conversations: 1_000,
      messages: 10_000,
      usageEvents: 2_500,
      auditEntries: 2_500,
      projects: 20,
      projectFiles: 100,
    },
    load: {
      signinRate: 5,
      signinRampSeconds: 5,
      signinHoldSeconds: 10,
      steadySeconds: 40,
      vus: { browse: 4, chat: 2, search: 2, project: 2, admin: 1, jobs: 1 },
      retentionSeconds: 20,
    },
    // Rough upper bound on database size, used to refuse a run that would fill the disk.
    estimatedGigabytes: 0.3,
  },
  small: {
    dataset: {
      people: 1_000,
      conversations: 50_000,
      messages: 500_000,
      usageEvents: 125_000,
      auditEntries: 125_000,
      projects: 800,
      projectFiles: 5_000,
    },
    load: {
      signinRate: 20,
      signinRampSeconds: 15,
      signinHoldSeconds: 45,
      steadySeconds: 180,
      vus: { browse: 20, chat: 10, search: 5, project: 4, admin: 1, jobs: 1 },
      retentionSeconds: 60,
    },
    estimatedGigabytes: 3,
  },
  medium: {
    dataset: {
      people: 6_000,
      conversations: 400_000,
      messages: 4_000_000,
      usageEvents: 1_000_000,
      auditEntries: 1_000_000,
      projects: 6_000,
      projectFiles: 40_000,
    },
    load: {
      signinRate: 40,
      signinRampSeconds: 30,
      signinHoldSeconds: 60,
      steadySeconds: 300,
      vus: { browse: 40, chat: 20, search: 10, project: 8, admin: 2, jobs: 1 },
      retentionSeconds: 180,
    },
    estimatedGigabytes: 20,
  },
  large: {
    dataset: {
      people: 30_000,
      conversations: 2_000_000,
      messages: 20_000_000,
      usageEvents: 5_000_000,
      auditEntries: 5_000_000,
      projects: 30_000,
      projectFiles: 200_000,
    },
    load: {
      signinRate: 80,
      signinRampSeconds: 60,
      signinHoldSeconds: 120,
      steadySeconds: 600,
      vus: { browse: 80, chat: 40, search: 20, project: 16, admin: 2, jobs: 1 },
      retentionSeconds: 600,
    },
    estimatedGigabytes: 75,
  },
};

/** Proposed targets (design doc, "Open questions"), in milliseconds at p95. */
export const TARGETS = {
  sidebar_ms: 300,
  conversation_open_ms: 300,
  chat_pre_model_ms: 1000,
  project_pre_model_ms: 1000,
  search_ms: 1000,
};

export function profileNamed(name) {
  const profile = PROFILES[name];
  if (!profile) {
    throw new Error(`Unknown profile "${name}"; choose one of ${Object.keys(PROFILES).join(', ')}`);
  }
  return { name, ...profile };
}

// `node profiles.mjs <name> [field.path]` prints a profile (or one value) for run.sh.
// k6 imports this module too, and has no `process`.
if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('profiles.mjs')) {
  const [name, path] = process.argv.slice(2);
  let value = name ? profileNamed(name) : PROFILES;
  for (const key of path ? path.split('.') : []) value = value?.[key];
  console.log(typeof value === 'object' ? JSON.stringify(value) : String(value));
}
