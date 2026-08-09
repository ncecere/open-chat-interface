# Adding a feature

One small feature traced through every layer, using a real one: **pinning a
model so it sorts to the top of the picker**.

Each step names the file and says why it exists, so the pattern transfers to
something larger.

## 1. The schema

`packages/db/src/schema/provider.ts`:

```ts
export const model = pgTable('model', {
  // ...existing columns
  /**
   * Sorts to the top of the picker. Distinct from `isDefault`, which is the
   * one model a new conversation starts with — an instance may want several
   * models prominent without changing where conversations begin.
   */
  pinned: boolean('pinned').notNull().default(false),
});
```

The comment earns its place: the difference between `pinned` and `isDefault` is
exactly what a reader would otherwise have to reconstruct.

## 2. The migration

```bash
pnpm db:generate
```

Read what it produced:

```sql
ALTER TABLE "model" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;
```

Additive, with a default, so an existing row is unaffected. That is what you
want; a `NOT NULL` column with no default would fail against a populated table.

```bash
pnpm db:migrate
pnpm --filter @oci/db build
```

The build is not optional. `apps/api` typechecks against the built package and
will not see the column until it is rebuilt.

## 3. The shared type

`packages/shared/src/schemas/model.ts`:

```ts
export const catalogModelSchema = z.object({
  // ...
  pinned: z.boolean(),
});

export const upsertModelSchema = z.object({
  // ...
  pinned: z.boolean().default(false),
});
```

Two schemas because they are different questions: what the API returns, and what
it accepts. Then `pnpm --filter @oci/shared build`.

## 4. The API

`apps/api/src/services/models.ts` — the read, ordering by the new column:

```ts
.orderBy(desc(schema.model.pinned), asc(schema.model.sortOrder))
```

`apps/api/src/routes/admin/models.ts` — the write:

```ts
...(input.pinned !== undefined && { pinned: input.pinned }),
```

Guarded on `undefined` rather than truthiness: `false` is a value somebody meant
to send, and `if (input.pinned)` would silently discard unpinning.

## 5. The interface

`apps/web/src/components/admin/model-form-dialog.tsx` for the control, and
`apps/web/src/components/chat/model-picker.tsx` to show it.

The ordering is already correct, because the server decided it. The picker only
has to render the state:

```tsx
{model.pinned && <Pin className="size-3 text-[var(--accent-bright)]" />}
```

A token, not a literal colour, so it follows the instance's accent.

## 6. The tests

A unit test for the decision:

```ts
it('sorts pinned models above the rest regardless of sort order', () => {
  const models = [
    { slug: 'a', pinned: false, sortOrder: 1 },
    { slug: 'b', pinned: true, sortOrder: 99 },
  ];
  expect(orderModels(models).map((m) => m.slug)).toEqual(['b', 'a']);
});
```

And a live test for what the migration guarantees:

```ts
it('leaves existing models unpinned', async () => {
  // An upgrade must not silently reorder somebody's catalogue.
  const [row] = await db.execute(sql`select pinned from model limit 1`);
  expect(row?.pinned).toBe(false);
});
```

That second test is the one worth writing. The first checks a function; the
second checks that upgrading an existing instance does not change what its users
see.

## 7. Before opening a merge request

```bash
pnpm lint:fix && pnpm lint
pnpm typecheck
pnpm test
```

Then **look at it in a browser**. Pin a model, open the picker, confirm it moved.

Several defects in this codebase compiled cleanly, passed review, and were
caught only here: a config diff that leaked an SMTP password into the audit log,
a link that navigated but silently ignored its filter, an info card that
overflowed the viewport at 1280 pixels. None of them would have been found by
reading the diff again.

## What the merge request should say

Say what changed and **why the obvious alternative was rejected**. A reviewer can
read the diff; what they cannot recover is the reasoning.

If something was found while testing, say so. "Caught while exercising this: the
first version discarded `false`" tells the next person which mistake this code
is shaped to avoid.
