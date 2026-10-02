import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'cobertura'],
      // Only application code; entrypoints and generated output are noise here.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/scripts/**', 'src/server.ts'],
      /**
       * Deliberately no global threshold. Coverage counts lines executed, not
       * behaviour verified, so a repository-wide percentage mostly rewards
       * tests written for the metric.
       *
       * These per-file floors sit just below today's measured values and cover
       * the modules where a regression is a security bug rather than a
       * correctness one: authorization, credential handling, untrusted input
       * validation, quota enforcement, and share sanitization. They are a
       * ratchet against silent erosion, not a target to chase.
       */
      thresholds: {
        'src/auth/permissions.ts': { statements: 100, branches: 100, functions: 100 },
        'src/auth/policy.ts': { statements: 85, branches: 85, functions: 100 },
        'src/lib/crypto.ts': { statements: 85, branches: 95, functions: 70 },
        'src/services/attachments/validate.ts': { statements: 95, branches: 78, functions: 85 },
        'src/services/attachments/upload.ts': { statements: 95, branches: 70, functions: 100 },
        'src/services/storage/usage.ts': { statements: 90, branches: 60, functions: 100 },
        'src/services/jobs/lock.ts': { statements: 100, branches: 100, functions: 100 },
        'src/services/quota/policy.ts': { statements: 90, branches: 78, functions: 100 },
        'src/services/chat/attachment-context.ts': { statements: 95, branches: 90, functions: 100 },
        'src/services/chat/context-budget.ts': { statements: 100, branches: 90, functions: 100 },
        'src/services/chat/generation-settings.ts': {
          statements: 95,
          branches: 90,
          functions: 100,
        },
        'src/services/chat/context-history.ts': { statements: 90, branches: 85, functions: 100 },
        'src/services/chat/model-context.ts': { statements: 90, branches: 85, functions: 100 },
        'src/services/chat/project-context.ts': { statements: 95, branches: 90, functions: 100 },
        'src/services/project-search/chunking.ts': { statements: 95, branches: 90, functions: 100 },
        'src/services/project-search/indexing.ts': { statements: 95, branches: 95, functions: 100 },
        'src/services/project-search/passages.ts': { statements: 95, branches: 95, functions: 100 },
        'src/services/project-search/retrieval.ts': {
          statements: 95,
          branches: 95,
          functions: 100,
        },
        'src/services/chat-stream-replay.ts': { statements: 90, branches: 80, functions: 100 },
        'src/services/chat-replay-validation.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
        },
        'src/services/chat/run-state.ts': { statements: 95, branches: 80, functions: 100 },
        'src/services/quota/settlement.ts': { statements: 95, branches: 95, functions: 100 },
        'src/services/quota/sweep.ts': { statements: 90, branches: 80, functions: 100 },
        'src/services/quota/windows.ts': { statements: 95, branches: 70, functions: 100 },
        'src/services/share-links.ts': { statements: 55, branches: 70, functions: 80 },
        // v0.8 tools: the tool set, approvals and the audit/usage paths of the loop.
        'src/services/tools/registry.ts': { statements: 95, branches: 95, functions: 100 },
        'src/services/tools/role-tools.ts': { statements: 95, branches: 95, functions: 100 },
        'src/services/tools/web-search.ts': { statements: 95, branches: 90, functions: 100 },
        'src/services/chat/tool-loop.ts': { statements: 85, branches: 80, functions: 90 },
        'src/services/chat/approvals.ts': { statements: 85, branches: 75, functions: 85 },
        'src/services/chat/pending-approvals.ts': { statements: 95, branches: 90, functions: 100 },
        // v0.8 MCP connectors: outbound network checks, credentials and OAuth, tool execution.
        'src/services/connectors/network.ts': { statements: 92, branches: 90, functions: 100 },
        'src/services/connectors/oauth.ts': { statements: 80, branches: 65, functions: 95 },
        'src/services/connectors/client.ts': { statements: 95, branches: 95, functions: 85 },
        'src/services/connectors/tools.ts': { statements: 90, branches: 85, functions: 90 },
        'src/services/connectors/admin.ts': { statements: 90, branches: 78, functions: 95 },
        'src/services/connectors/ids.ts': { statements: 100, branches: 80, functions: 100 },
        'src/services/connectors/people.ts': { statements: 90, branches: 85, functions: 100 },
        'src/routes/connectors.ts': { statements: 95, branches: 80, functions: 100 },
        'src/routes/admin/connectors.ts': { statements: 95, branches: 75, functions: 100 },
      },
    },
  },
});
