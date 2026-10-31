# Jump from a card to its pull request

<a id="pull-merge-request-links"></a>

<span class="vb-version" title="Added in 1.2">1.2+</span>

In a card's *Details* tab, open **Pull / merge request** → **+ Link a pull or merge request**, paste the URL, and click **Save link**.

**Why it matters:** Anyone looking at the board can jump from the work item straight to the code.

**By the numbers:**

- **One link per card.** To link a different pull request, edit the existing one.
- **Provider:** GitHub, GitLab, or Other.
- **Reference:** a short label such as `acme/web#12` or `group/project!45`.
- **Any http or https URL works**, so self-hosted GitLab and other code hosts are supported.

**Go deeper:** the link is also in the REST API; see [API](#api).

---

## Adding and editing a link

Open a card and find **Pull / merge request** in the *Details* tab, directly after **Relations**.

1. Click **+ Link a pull or merge request**.
2. Paste the URL. Visiban fills in the provider and reference.
3. Adjust either if needed.
4. Click **Save link**.

**Cancel** discards the change. **Escape** also cancels the edit, and a second **Escape** closes the panel.

On an existing link, **Edit** changes it and **Remove** deletes it. Remove is immediate, with no confirmation, because the link is easy to add again.

### How the URL is read

| URL you paste | Provider | Reference |
|---|---|---|
| `github.com/owner/repo/pull/N` | GitHub | `owner/repo#N` |
| Any GitLab URL containing `/-/merge_requests/N`, including self-hosted GitLab | GitLab | `namespace/project!N` |
| Any other http or https URL | Other | You type it |

GitLab subgroups are kept, so `group/subgroup/project!45` stays intact. You can override the detected provider and reference at any time.

---

## On the card face

A card with a link shows a small pull-request glyph at the **start** of its metadata row, before any other indicator.

| Card density | What the badge shows |
|---|---|
| Comfortable | The glyph only |
| Standard | The glyph and the reference, truncated if long |
| Dense | The glyph and the reference, truncated if long |

- **Hover (Comfortable):** shows the provider and reference, for example "GitHub acme/web#12 — github.com (opens in new tab)", which always shows the real host the link opens. The reference also appears in the hover peek as "GitHub acme/web#12".
- **Click:** opens the link in a new tab without opening the card. Cmd-click, Ctrl-click, and middle-click behave like any other link.
- **Compact (single-line) layout:** the badge is **hidden**, since there is no room. Open the card to see the link.

---

## Rules

- Only **http** and **https** URLs are accepted. Anything else shows "Enter a valid http or https URL." and **Save link** stays disabled.
- URLs containing a username or password are rejected.
- The URL can be up to 2048 characters.
- The reference is required, can't contain spaces or other whitespace/control characters, and can be up to 255 characters.
- Each card holds one link.

---

## Permissions

Linking follows the same rules as editing any other card field.

| Role | View and click the link | Add / edit / remove |
|---|---|---|
| Viewer | Yes | No |
| Collaborator | Yes | No |
| Member | Yes | Yes |
| Admin | Yes | Yes |

Members are subject to the board's "edit only cards you created" rule unless they are a moderator or admin.

Viewers and collaborators see the link and can click it, but get no edit controls. When a card has no link, they don't see the section at all.

---

## Real-time behavior

Adding, changing, or removing a link updates the card on everyone's board immediately, over the same channel as every other card change. See [Real-time Updates](realtime.md).

---

## Export, import, and sharing

- **JSON board export** includes the link, and **JSON import** restores it.
- **CSV export** does not include the link.
- **Public share links do not show the link.** Pull request URLs can reveal private repository names, so anonymous visitors never see them.

!!! note
    Adding, changing, or removing a link is not recorded in the card's activity history in this release.

---

## API

See the [Cards API](../api/cards.md#external-ref-since-12) for the link fields.
