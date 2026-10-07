// @vitest-environment happy-dom
import type { Provider } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { ModelFormDialog } from '../../src/components/admin/model-form-dialog';
import { Dialog } from '../../src/components/ui/dialog';
import { ThemeProvider } from '../../src/providers/theme-provider';
import { cleanup, renderAdmin } from './admin-test-utils';

let root: Root | undefined;
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const provider = {
  id: 'provider-1',
  kind: 'openai-compatible',
  label: 'Walk gateway',
  baseUrl: 'https://gateway.example.test/v1',
  hasApiKey: true,
  enabled: true,
} as unknown as Provider;

it('offers a new model to everyone who chats, but not to auditors', async () => {
  ({ root } = await renderAdmin(
    <ThemeProvider>
      <Dialog open>
        <ModelFormDialog model={null} providers={[provider]} onClose={() => undefined} />
      </Dialog>
    </ThemeProvider>,
  ));
  const pressed = (role: string) =>
    [...document.querySelectorAll('button[aria-pressed]')]
      .find((button) => button.textContent?.trim() === role)
      ?.getAttribute('aria-pressed');

  expect(pressed('admin')).toBe('true');
  expect(pressed('user')).toBe('true');
  expect(pressed('restricted')).toBe('true');
  // Same as the API's default and Discover models: auditors see no models.
  expect(pressed('auditor')).toBe('false');
});
