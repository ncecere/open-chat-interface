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
        // v0.9 compaction: what the model is sent, the cut, usage, overflow detection
        // and the background queue (claims, leases, retries, idempotent requests).
        'src/services/chat/compaction-queue.ts': { statements: 90, branches: 80, functions: 100 },
        'src/services/chat/compaction-plan.ts': { statements: 95, branches: 90, functions: 100 },
        'src/services/chat/compaction.ts': { statements: 90, branches: 78, functions: 95 },
        'src/services/chat/compaction-fork.ts': { statements: 95, branches: 70, functions: 100 },
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
        // v0.9 artifacts: ownership, size and storage admission, tools, the API and guidance.
        'src/services/artifacts/store.ts': { statements: 90, branches: 78, functions: 100 },
        'src/services/artifacts/guidance.ts': { statements: 95, branches: 90, functions: 100 },
        'src/services/tools/artifacts.ts': { statements: 95, branches: 90, functions: 100 },
        'src/routes/artifacts.ts': { statements: 95, branches: 95, functions: 100 },
        // v0.9 file output: owner-only lookup, limits and allowance, untrusted Markdown in,
        // generated files out. render-worker.ts runs in a worker thread, which coverage
        // does not see; the worker tests in documents-render exercise it.
        'src/services/documents/export.ts': { statements: 98, branches: 95, functions: 100 },
        'src/services/documents/render.ts': { statements: 93, branches: 78, functions: 90 },
        'src/services/documents/model.ts': { statements: 91, branches: 83, functions: 100 },
        'src/services/documents/docx.ts': { statements: 94, branches: 87, functions: 100 },
        'src/services/documents/pdf.ts': { statements: 92, branches: 77, functions: 100 },
        'src/services/documents/xlsx.ts': { statements: 98, branches: 88, functions: 100 },
        'src/services/documents/pptx.ts': { statements: 95, branches: 85, functions: 100 },
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
        // v0.9 operations: webhook signing and outbound delivery, backup credentials and
        // retention, metrics authentication and what metrics and spans may carry.
        'src/services/webhooks/signing.ts': { statements: 100, branches: 100, functions: 100 },
        'src/services/webhooks/delivery.ts': { statements: 85, branches: 70, functions: 75 },
        'src/services/webhooks/endpoints.ts': { statements: 90, branches: 85, functions: 95 },
        'src/services/backups/pg-tools.ts': { statements: 90, branches: 75, functions: 85 },
        'src/services/backups/retention.ts': { statements: 100, branches: 100, functions: 100 },
        'src/services/backups/run.ts': { statements: 88, branches: 70, functions: 85 },
        'src/services/backups/settings.ts': { statements: 93, branches: 88, functions: 90 },
        'src/services/observability/http.ts': { statements: 98, branches: 90, functions: 100 },
        'src/services/observability/metrics.ts': { statements: 95, branches: 75, functions: 100 },
        'src/services/observability/tracing.ts': { statements: 90, branches: 72, functions: 95 },
        'src/services/observability/events.ts': { statements: 100, branches: 100, functions: 100 },
        'src/routes/admin/webhooks.ts': { statements: 98, branches: 70, functions: 100 },
        'src/routes/admin/backups.ts': { statements: 85, branches: 50, functions: 100 },
        // v0.9 compliance export and legal hold: the cursor (exactly once), what content
        // leaves OCI, and the holds that stop retention and deletion.
        'src/services/compliance/export.ts': { statements: 90, branches: 78, functions: 90 },
        'src/services/compliance/cursor.ts': { statements: 82, branches: 75, functions: 80 },
        'src/services/compliance/content.ts': { statements: 98, branches: 85, functions: 100 },
        'src/services/compliance/holds.ts': { statements: 75, branches: 60, functions: 75 },
        'src/services/compliance/hold-errors.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
        },
        'src/services/compliance/settings.ts': { statements: 98, branches: 95, functions: 100 },
        'src/routes/admin/compliance.ts': { statements: 88, branches: 60, functions: 100 },
        // v0.9 meaning-based search: provider credentials, runtime DDL, usage, fallback.
        'src/services/embeddings/config.ts': { statements: 95, branches: 95, functions: 100 },
        'src/services/embeddings/embed.ts': { statements: 95, branches: 90, functions: 100 },
        'src/services/embeddings/model.ts': { statements: 95, branches: 90, functions: 100 },
        'src/services/embeddings/status.ts': { statements: 95, branches: 80, functions: 100 },
        'src/services/embeddings/storage.ts': { statements: 95, branches: 90, functions: 100 },
        'src/services/embeddings/usage.ts': { statements: 85, branches: 80, functions: 100 },
        'src/services/project-search/embedding.ts': {
          statements: 90,
          branches: 85,
          functions: 100,
        },
        'src/services/project-search/fusion.ts': { statements: 95, branches: 95, functions: 100 },
        'src/services/project-search/semantic.ts': { statements: 95, branches: 95, functions: 100 },
        'src/routes/admin/embeddings.ts': { statements: 95, branches: 90, functions: 100 },
        // v0.9 user memory: every switch, temporary chats, ownership, limits and the prompt budget.
        'src/services/memory/access.ts': { statements: 100, branches: 95, functions: 100 },
        'src/services/memory/prompt.ts': { statements: 88, branches: 80, functions: 100 },
        'src/services/memory/store.ts': { statements: 90, branches: 80, functions: 100 },
        'src/services/memory/tools.ts': { statements: 98, branches: 95, functions: 100 },
        'src/routes/memory.ts': { statements: 98, branches: 95, functions: 100 },
        // v0.9 reranking: provider credentials, the outbound client, usage, fallback.
        'src/services/reranking/client.ts': { statements: 95, branches: 95, functions: 75 },
        'src/services/reranking/config.ts': { statements: 95, branches: 95, functions: 100 },
        'src/services/reranking/reranker.ts': { statements: 95, branches: 95, functions: 100 },
        'src/services/reranking/usage.ts': { statements: 95, branches: 95, functions: 100 },
        'src/services/project-search/rerank.ts': { statements: 95, branches: 95, functions: 100 },
        'src/routes/admin/reranking.ts': { statements: 95, branches: 95, functions: 100 },
      },
    },
  },
});
