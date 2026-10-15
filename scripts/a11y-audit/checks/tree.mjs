/**
 * Step 3 of the Method: the accessibility tree as Chromium computes it
 * (`Accessibility.getFullAXTree`). Names, roles and states of controls, from the same tree a
 * screen reader is given, not from the markup.
 */

const NAMED = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'slider',
  'spinbutton',
  'dialog',
  'alertdialog',
  'img',
  'treeitem',
]);

/**
 * The attribute a custom control (one built from a role on a plain element) must carry for its
 * state to be exposed. Chromium reports a default state for a checkbox with no `aria-checked`,
 * so the tree alone cannot tell a state that is exposed from one that is made up: the attribute
 * is read from the element behind the node.
 */
const STATE_ATTRIBUTE = {
  checkbox: 'aria-checked',
  switch: 'aria-checked',
  radio: 'aria-checked',
  tab: 'aria-selected',
  combobox: 'aria-expanded',
};

async function lacksStateAttribute(cdp, backendDOMNodeId, attribute) {
  try {
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: backendDOMNodeId });
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      returnByValue: true,
      functionDeclaration: `function (attribute) {
        // A native input or select exposes its own state.
        if (/^(INPUT|SELECT|DETAILS|BUTTON)$/.test(this.tagName) && this.tagName !== 'BUTTON') return false;
        return !this.hasAttribute(attribute);
      }`,
      arguments: [{ value: attribute }],
    });
    return result.value === true;
  } catch {
    return false;
  }
}

async function selectorOf(cdp, backendDOMNodeId) {
  try {
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: backendDOMNodeId });
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      returnByValue: true,
      functionDeclaration: `function () {
        const parts = [];
        for (let node = this; node && node.nodeType === 1 && parts.length < 3; node = node.parentElement) {
          if (node === document.body) break;
          const classes = [...node.classList].filter((name) => !/[[\\]:/]/.test(name)).slice(0, 2);
          parts.unshift(node.tagName.toLowerCase() + (classes.length ? '.' + classes.join('.') : ''));
        }
        return parts.join(' > ');
      }`,
    });
    return result.value ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function treeCheck(page, { evidence, route, context }) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('Accessibility.enable');
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    evidence.sample(['4.1.2'], 'tree', route);
    const roles = {};
    let unnamed = 0;
    for (const node of nodes) {
      if (node.ignored) continue;
      const role = node.role?.value;
      if (!role) continue;
      roles[role] = (roles[role] ?? 0) + 1;
      const name = String(node.name?.value ?? '').trim();
      if (NAMED.has(role) && name === '' && node.backendDOMNodeId) {
        unnamed += 1;
        if (unnamed <= 10) {
          evidence.finding({
            criteria: ['4.1.2'],
            check: 'tree',
            rule: 'control-without-name',
            severity: 'serious',
            route,
            context,
            message: `A ${role} has no accessible name in the accessibility tree`,
            targets: [await selectorOf(cdp, node.backendDOMNodeId)],
          });
        }
      }
      const attribute = STATE_ATTRIBUTE[role];
      if (
        attribute &&
        node.backendDOMNodeId &&
        (await lacksStateAttribute(cdp, node.backendDOMNodeId, attribute))
      ) {
        evidence.finding({
          criteria: ['4.1.2'],
          check: 'tree',
          rule: 'control-without-state',
          severity: 'moderate',
          route,
          context,
          message: `A custom ${role} has no ${attribute}, so its state is not exposed`,
          targets: [await selectorOf(cdp, node.backendDOMNodeId)],
        });
      }
    }
    evidence.count('tree', 'nodes', nodes.length);
    evidence.count('tree', 'unnamed-controls', unnamed);
    evidence.fact('tree', route, {
      roles: Object.fromEntries(
        [
          'button',
          'link',
          'textbox',
          'combobox',
          'checkbox',
          'switch',
          'tab',
          'dialog',
          'heading',
          'table',
          'main',
          'navigation',
          'status',
          'alert',
          'log',
        ]
          .filter((role) => roles[role])
          .map((role) => [role, roles[role]]),
      ),
    });
    evidence.limit(
      'tree',
      "Chromium's tree, not a screen reader's speech: it shows that a name, role and state exist, not that a person using JAWS, NVDA, VoiceOver or TalkBack would find them clear. No screen reader was driven by a person.",
    );
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}
