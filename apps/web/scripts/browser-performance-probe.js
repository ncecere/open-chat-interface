// Install with agent-browser --init-script before navigation. Synthetic fixture
// pages only. Records timings/counts, never input text, cookies or response bodies.
// keyToFrameMs is dispatch-to-next-rAF, NOT INP or a completed-paint guarantee.
(() => {
  const state = {
    supportedEntries: PerformanceObserver.supportedEntryTypes,
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    viewport: { width: innerWidth, height: innerHeight },
    composerReadyAt: null,
    modelReadyAt: null,
    longTasks: [],
    keys: [],
    run: null,
    pageErrors: 0,
  };
  window.__ociPerformance = state;
  if (state.supportedEntries.includes('longtask')) {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (state.longTasks.length < 5000)
          state.longTasks.push({ start: entry.startTime, duration: entry.duration });
      }
    }).observe({ type: 'longtask', buffered: true });
  }
  window.addEventListener('error', () => {
    state.pageErrors++;
  });
  window.addEventListener('unhandledrejection', () => {
    state.pageErrors++;
  });
  const inputSelector = 'textarea[aria-label="Message input"]';
  const assistantSelector = 'article[aria-label="Assistant message"]';
  const start = () => {
    performance.mark('oci-send');
    state.run = {
      startedAt: performance.now(),
      previousAssistants: document.querySelectorAll(assistantSelector).length,
      firstTextAt: null,
      endedAt: null,
      sawPending: false,
      renderedCharacters: 0,
    };
  };
  document.addEventListener(
    'click',
    (event) => {
      if (
        event.target instanceof Element &&
        event.target.closest('button[aria-label="Send message"]:not(:disabled)')
      )
        start();
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.matches(inputSelector) ||
        !event.isTrusted
      )
        return;
      if (
        event.key === 'Enter' &&
        !event.shiftKey &&
        document.querySelector('button[aria-label="Send message"]:not(:disabled)')
      )
        start();
      const startTime = event.timeStamp;
      const duringStream = Boolean(state.run && state.run.endedAt === null);
      requestAnimationFrame(() => {
        if (state.keys.length < 2000)
          state.keys.push({
            start: startTime,
            keyToFrameMs: performance.now() - startTime,
            duringStream,
          });
      });
    },
    true,
  );
  let scheduled = false;
  const inspect = () => {
    scheduled = false;
    const now = performance.now();
    if (state.composerReadyAt === null && document.querySelector(inputSelector))
      state.composerReadyAt = now;
    const model = document.querySelector('button[aria-label^="Select model. Current model:"]');
    if (
      state.modelReadyAt === null &&
      model &&
      !model.getAttribute('aria-label').endsWith(': none')
    )
      state.modelReadyAt = now;
    const run = state.run;
    if (!run || run.endedAt !== null) return;
    const pending = Boolean(document.querySelector('button[aria-label="Stop generating"]'));
    if (pending) run.sawPending = true;
    const assistants = document.querySelectorAll(assistantSelector);
    if (assistants.length > run.previousAssistants) {
      const content = assistants[assistants.length - 1].querySelector(
        '[class*="prose-headings:font-semibold"]',
      );
      run.renderedCharacters = content?.textContent?.length ?? 0;
      if (run.firstTextAt === null && run.renderedCharacters > 0) run.firstTextAt = now;
    }
    if (run.sawPending && !pending) {
      run.endedAt = now;
      performance.mark('oci-stream-finished');
    }
  };
  new MutationObserver(() => {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(inspect);
    }
  }).observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-label', 'disabled'],
  });
})();
