# Groups

A group is a set of people who share a budget, some extra models, or both:
a department, a course, a research team. **People → Groups** (`/admin/groups`).

Groups **add**. A person's role still decides what they may do, and nothing a
group does takes an access away. A group can give a budget and a model.
It cannot change storage, rate limits, features or tools; those stay with the
role ([Roles and access](governance.md#roles-and-access)).

A group is for budgets and models. [Roles](governance.md#roles-and-access)
remain the four fixed ones.

## Creating a group and adding people

**New group** takes a name (up to 80 characters, unique ignoring case) and an
optional description (up to 300). Open the group to add people.

- **Members** — **Add by email** takes up to 200 addresses at once. Each address is sorted into one of three lists
  in the answer: added, already in the group, and no account with this
  address. Nobody is added when a limit would be broken (see
  [Limits](#limits)).
- **Managers** — a manager is a member who can also add and remove members
  (see [Managers](#managers)). Choose a member's role in the list; promote or
  demote there. A manager counts as a member for budgets and models.
- **Removing** takes effect on the person's next request: the budgets and
  models the group gave them stop applying at once.

The member list shows name, email and role, and can be searched by name or
email. A person can be in any number of groups, up to 50.

Groups are made by hand. Single sign-on sets a person's role and nothing else:
there is no group mapping from the identity provider, so a misconfigured
provider cannot grant budgets or models at sign-in.

## What a group grants

On the group's **Budgets and models** tab, two checklists: the
[usage budgets](governance.md#usage-budgets) the group carries and the models it
may use. Saving replaces both lists. Grants are written **only from the group**.
The budget and model pages show a group as a chip next to what it carries,
read-only, and a client that sends groups through those forms is refused, so a
form saved by an older page can never clear a group's grants.

### Budgets

A person's budgets are the distinct enabled budgets attached to their role
**or** to any group they are in. Each one is then treated as any role budget is:

- it applies if it covers the model being used;
- a per-person override, if the person has one, replaces its limit
  ([Overrides](governance.md#overrides) now work on a budget a group carries);
- it is checked on its own against the person's own usage;
- the person is refused when **any** of them is spent.

So the **most restrictive budget wins and nothing is added up**:

| The person has | What happens |
| --- | --- |
| a role budget of 500 messages a month and a group budget of 200 | 200 is the limit that bites first. The group budget never raises the role budget to 700. |
| a role budget of 200 and a group budget of 500 | 200 bites first. A group cannot make a budget looser than the role's. |
| two groups, with budgets of 300 and 400 | Both are enforced, each against the person's own usage. The person is stopped at 300. |
| the same budget on their role and on their group, or on two of their groups | It counts once. |
| a group budget the administrator disabled | Ignored. |
| no group | Nothing changes: people outside every group are unaffected. |

Budgets are **per person, not a pool**: a group budget of 200 messages gives
each member their own 200, not 200 between them. To give a department more than
the role's budget, raise it for them with a per-person override, or give the
role a larger budget and use the group to hold some members to less.

People never see a group's or a budget's name, only what a budget counts and its
period, as for any budget. **People → Users → Limits** (administrators and
auditors) names where each of a person's budgets comes from: the role, or the
group.

### Models

A model is visible to a person if their **role** is listed under **Visible to
roles** on [Providers & Models](models-providers.md), **or** any group they are
in is granted the model. A disabled model, or a model on a disabled provider,
stays unavailable to everyone. This is how a department gets an expensive model
without opening it to a whole role. A group never hides a model the role can
see.

The per-role model counts on **Roles & access** stay role-only; the **Groups**
section below them lists each group's extra models.

## Managers

A group manager is a signed-in person who manages at least one group. They get
**Settings → Groups** ([for managers](../user/groups.md)) and can, for the groups
they manage and no others:

- see the member list (name, email, role);
- add members by email (always as members);
- remove a member, or remove themselves.

They cannot see or change what the group grants, see usage, appoint or remove a
manager (only an administrator does), rename or delete the group, or reach any
administrator page. Looking people up by email is limited to 30 requests a
minute per manager.

The answers are chosen so a manager learns nothing about groups they have no
part in: a person who is in no group and manages none gets "not found" for
every managed-group address; a member who is not a manager, and a manager of
another group, are refused.

Administrators change members and managers on the group page; an auditor can
read everything on it and change nothing.

## Usage

The group page has a **Usage** card: what the group's **current** members used in
the last 30 days by default, up to 90 (messages, tokens, cost), and the busiest people.
The card lists at most the 100 busiest people and says when there are more.
It is a view of who is in the group now, so someone who left is not counted, and
someone who joined brings their history. A person in two groups appears in
both. The [usage reports](audit-reporting.md#usage) have no group dimension on
purpose: it would relabel history every time membership changed. Managers do
not see this card.

## Limits

| What | Limit |
| --- | --- |
| Groups on the instance | 500 |
| Members in a group | 5,000 |
| Managers in a group | 20 |
| Groups one person is in | 50 |
| Email addresses in one "add" | 200 |

A request that would break a limit changes nothing and says the number.
Two people adding the last member at the same moment cannot both succeed.

## Deleting a group

The delete dialog says how many members, budgets and models are affected. People
stay; they lose what the group gave them on their next request. Nothing that
belonged to a person is deleted, so a person on
[legal hold](compliance.md#legal-hold) can be removed from a group, or the group
deleted.

## What is recorded

Every change is in the [audit log](audit-reporting.md) and kept regardless of
retention: `group.create`, `group.update` (what changed), `group.delete`
(members, budgets and models removed), `group.member.add` and
`group.member.remove` (every account, and whether a manager did it),
`group.member.role`, and `group.grants.update` (the budget and model ids before
and after). [Webhooks](observability.md#webhooks) carry them unchanged.

## Upgrading to v0.14

Groups, and the budgets and models they grant, exist only in v0.14. While an
older replica is still serving during a rolling upgrade it would not enforce a
group's budget and would not offer a group's models. So **changing a group's
grants answers "An upgrade is still in progress"** while any live replica
reports an earlier release. Wait until the upgrade has finished, then set the
grants. Create no groups you rely on until then; see [Operations](../OPERATIONS.md#upgrading-to-v014).
