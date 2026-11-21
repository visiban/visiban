# Card-detail extensions

!!! warning "Experimental in 1.3"
    `CARD_DETAIL_EXTENSIONS` is experimental in 1.3: the protocol and the wire
    shape may change before they are declared stable, which is planned once the
    first real extension ships. Pin your extension to the Visiban minor version
    you tested it against.

A card-detail extension attaches a typed, **read-only** record to a card (a
contract, a sales opportunity, an initiative's budget) and Visiban renders it in
the card's **Details** tab, after Weight. It is the card-level counterpart of
`ANALYTICS_EXTENSIONS` panels. OSS stays domain-neutral: the extension owns its
own model, migrations and admin; OSS only calls it and renders what it returns
(#2212, epic #2206).

## Registering

An extension is an in-process Django app. Register an **object** (not a bare
function) in its `AppConfig.ready()`:

```python
from boards.hooks import CARD_DETAIL_EXTENSIONS


class ContractSection:
    id = "contracts"          # ^[a-z][a-z0-9_-]{0,63}$, unique
    min_role = "member"       # viewer | collaborator | member | admin | site_admin

    def section(self, card, user, role):
        contract = Contract.objects.filter(card_id=card.pk).first()
        if contract is None:
            return None       # not for this card: nothing renders
        return {
            "title": "Contract",
            "fields": [
                {"key": "value", "label": "Value", "type": "number",
                 "value": float(contract.value), "display": f"${contract.value:,.0f}"},
                {"key": "stage", "label": "Stage", "type": "choice",
                 "value": contract.stage, "choices": ["Draft", "Signed"]},
                {"key": "renews", "label": "Renews", "type": "date",
                 "value": contract.renews.isoformat() if contract.renews else None},
            ],
        }


CARD_DETAIL_EXTENSIONS.append(ContractSection())
```

## Contract

- **`min_role`** decides who the section is computed for. **Missing, `None` or
  invalid means `admin`** (fail closed). OSS filters on the caller's board role
  before calling `section()`, so an extension above the caller's role is never
  invoked (Security Invariants Rule 12). You may narrow further by inspecting
  `user` or `role`.
- **`section(card, user, role)`** returns one section or `None`. It is called on
  every card the viewer opens, on every board; return `None` quickly when the
  card is not yours (for example check `card.board.cards_can_have_children`).
- There is **no `request` argument**: headers and tokens stay out of extension code.
- Treat `card` and `user` as read-only. Do no blocking network I/O; the call runs
  inside a request. Your own outbound calls (and their SSRF risks) are your
  concern.
- Read card links only through `boards.services.card_links.children_for_viewer`
  / `parents_for_viewer` with the same `user` (Security Invariants Rule 10).
- **Read-only in v1.** There is no edit path; extra keys such as `editable` are
  ignored and not sent to the client.

## Validation and failure isolation

The wire shape and its limits are in the
[API reference](../api/cards.md). OSS
validates every section on the server and again in the browser:

- Field types are closed: `text`, `number`, `date`, `choice`. HTML, Markdown,
  links and user references are not rendered; everything is plain text.
- A section that breaks any rule is **dropped whole**, never truncated.
- An extension that raises is logged with its class name and the exception
  class only (never values, labels or exception text) and left out; the other
  sections still render.
- At most 10 extensions are called per card; a later one sharing an earlier
  one's `id` is skipped.

## Where sections appear

Only `GET /api/v1/boards/{b}/cards/{c}/extensions/`, fetched when the Details
tab opens. Never on the card payload, `/full/`, the card list, MCP, exports,
the public share link or WebSocket frames. Edits write no History row, because
there are no edits in v1.
