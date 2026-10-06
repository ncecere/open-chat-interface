import { act } from 'react';

/**
 * Fills every empty field of the auth form in `scope` with a valid value, as
 * a person would before pressing the button: the forms check their fields
 * themselves (noValidate), so an empty submit no longer reaches the sign-in
 * service (#320's sweep).
 */
export async function fillAuthForm(scope: ParentNode) {
  const form = scope.querySelector('form');
  if (!form) return;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    for (const input of form.querySelectorAll<HTMLInputElement>('input')) {
      if (input.value || input.readOnly || !['text', 'email', 'password'].includes(input.type))
        continue;
      const value =
        input.type === 'email'
          ? 'person@example.test'
          : input.type === 'password'
            ? 'Correct-horse-battery-1'
            : 'Pat Example';
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}
