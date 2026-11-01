<a id="service-layer"></a>

# Board rules live in services, not views

Board mutations that carry invariants live in `backend/boards/services/`, not in the DRF views that expose them over HTTP.

**Why it matters:** An invariant inside an HTTP handler is reachable only by an HTTP request, so every other writer (MCP, import, webhooks) must re-implement the rules or skip them.

**The big picture:** one service function per card state transition owns the checks, locks, audit trail, transaction, and side effects. Views keep parsing, validation, and serialization. Import/export and the Django admin still [bypass it, on purpose](#write-paths-that-remain-divergent).

**Watch out:** the lock order is a deadlock-avoidance contract. Reordering locks can deadlock concurrent moves.

**Go deeper:** [Field Enforcement](field-enforcement.md) lists which limits bind where.

## Why the layer exists

Until Visiban 1.2 every card state transition lived inline in `CardViewSet`. A second consumer broke that: it had to re-implement the rules or skip them. Both had already happened:

- The MCP tool scaffold carried its own copy of the board-role precedence ladder, with a comment saying it "must be kept in step with" the original. Nothing enforced that.
- A `PATCH` that changed a card's `column` bypassed WIP enforcement and the movement audit trail entirely, because only the move endpoint evaluated them.

The API has several writers in view (a second front end, MCP write tools, import, and webhooks, planned in #863), so the invariants need a home that is not a request handler.

## What a service function owns

For one state transition, a service function owns:

| Concern | Example |
|---|---|
| Role allow-list | only `member`, `admin`, `site_admin` may mutate a card |
| Ownership / assignment gate | a member may edit only cards they created, unless they hold the moderator entitlement |
| Optimistic concurrency | compare the caller's `version` against the stored row |
| Row locks, in a fixed order | the moved card plus every card in its source and target cells, in one statement ordered by pk → the source and target column rows, in one statement ordered by pk (`FOR NO KEY UPDATE`, on every move; a same-cell reorder locks its one column) |
| Limit enforcement | WIP soft, WIP hard, weight, and the `force` override authorization — one helper, `enforce_column_limits()`, shared by move, create, restore, and a weight increase on update (#1428) |
| Audit trail | the `CardMovement` row and the `CardActivity` diff |
| The transaction | one `atomic()` block per transition |
| Deferred side effects | the `transaction.on_commit()` WebSocket broadcast and `CARD_MUTATION_HOOKS` |

### Lock order is a contract

**The big picture:** concurrent moves queue instead of deadlocking only because every caller takes the same locks in the same sequence. These rules are easy to undo by accident.

**Card and column locks (#1522, #1566, #1567, #1588):**

1. **Never lock card rows one statement at a time.** Locking the moved card and then its siblings deadlocked two moves out of one cell: each held its own card and wanted the other's. The source cell is known only after the card is read, so `move_card` reads it unlocked, locks the cells, and re-checks the card under the lock. It retries if a concurrent writer changed it, and returns `409` if that keeps happening.
2. **Lock columns after cards, in one pk-ordered statement.** Source and target columns lock together, before the `CardMovement` insert takes key-share locks on both. A column reorder holds `FOR UPDATE` on every column (`position` is part of a unique key) in the same pk order. A move that locked only its target column deadlocked against a reorder. For that reason the column lock is taken on every move, including a reorder within one cell.
3. **Use `FOR NO KEY UPDATE` for the column lock**, so that it does not block the key-share locks unrelated inserts take on the column (a card created in it, say). Under the current order a plain `FOR UPDATE` would not make two moves deadlock; the mode is pinned only by `test_move_locks_cards_then_columns_in_pk_order`.
4. **Re-read the cells' members once the columns are held (`_require_cells_locked`).** The card-row lock statement locks the rows of the snapshot it took before it waited. A card that a concurrent move commits into a cell during that wait is not locked, so the later compaction or shift `UPDATE` would lock it outside pk order and a third move could deadlock (#1567). Every service path that puts a card into a cell (`create_card`, `move_card` and the tools that call them) takes the column rows, so `move_card` retries if any cell member is unlocked.
5. **Django admin follows the same order (#1588).** `CardAdminForm.clean` locks the card row and re-reads it. It then locks the source and target columns in one pk-ordered statement whenever the card's column or swimlane changes (archived cards included) or a WIP/weight check runs. The check counts under that lock.
6. **`create_card` against a column reorder (#1566).** Fixed by taking the reorder's board-row lock `FOR NO KEY UPDATE`. The card insert's foreign-key check needs `FOR KEY SHARE` on the board row at commit, which a `FOR UPDATE` board lock blocks while the reorder waits on the column the create holds.

**Deleting a user from the Django admin (#1616):** locks go user, group, card, user, in three statements.

1. **Statement 1.**
    - Locks the targets, the acting administrator, the active site-admin and superuser rows, and the account rows of every admin of a group a target actively administers (`groups.services.admin_accounts_of_groups_administered_by`, #1814) `FOR NO KEY UPDATE`. That does not block the `FOR KEY SHARE` that card writes and board inserts take on a user row.
    - Then locks, `FOR NO KEY UPDATE` and in pk order, the rows of every group a target actively administers (`groups.services.lock_groups_administered_by`). Every group member removal, demotion, and ownership transfer takes this lock first, so for those groups the "keep an active group admin" refusal judges admin rows that nothing can alter before the delete commits.
    - The set is the groups the targets actively administer when statement 1 runs. A promotion of a target, or an ownership transfer to one, locks the target's account row first, so it queues behind the delete and then finds the membership gone. The other admins' account rows are held, so a deactivation of one of them queues too. An account made a group admin after statement 1 is counted by the statement 3 re-check without its row held.
    - Account rows before group rows is the order every group writer that locks an account row follows (Rule 11 of `docs/development/security-invariants.md`, and `groups/services.py` above `lock_member_accounts`). Any other group writer needs at most `FOR KEY SHARE` on a user row, which statement 1 does not block, so taking the group rows after the user rows cannot invert.
2. **Statement 2.** Locks the owned boards' rows `FOR NO KEY UPDATE`, then the cards the cascade will write (the owned boards' cards and every card carrying a reference to a target) `FOR UPDATE`, then the owned boards' entry columns (`lock_cards_for_cascade()` with `boards=` and `entry_columns=`, #1602). The board -> card -> column order matches every other container delete.
3. **Statement 3.** Locks the target rows `FOR UPDATE` and judges the refusals again, so a board committed by then is seen and the delete is refused.

**Yes, but:** the card set is a snapshot taken at statement 2, like the snapshot in #1567. A card that gains a reference to a target between statements 2 and 3 is not locked. The cascade's `SET NULL` update of it runs while the delete holds the user row `FOR UPDATE`, and a writer holding that card, which needs `FOR KEY SHARE` on the user at commit, can deadlock with it. PostgreSQL aborts one side, which can be the delete; no data is lost. Apart from those group rows, tables not scoped to a card are not locked.

### Writes to an existing card vs. a hard delete (#1587)

- **Who:** `update_card`, `archive_card`, `unarchive_card` (before its column limit check), `block_card` and `unblock_card` (#1149), and the card-child writes in `CardViewSet` (comment, checklist item, and attachment create; checklist item edit and delete, which write an activity row) call `lock_card_for_write()` first in their transaction. It locks the card row `FOR NO KEY UPDATE` and raises `CardNotFound` (a `404`) if the row is already gone.
- **Relation create** gets the same answer from its pk-ordered lock on both cards.
- **`delete_card`** locks the row `FOR UPDATE` before Django collects its cascade, and re-checks `archived_at` under that lock so a card archived concurrently is still refused.
- **Why:** without them, a delete committing mid-write let `update_card`'s `save()` fall back to an `INSERT` that re-created the deleted card, made an archive or restore's `save(update_fields=...)` match no row (a `500`), or failed the child insert's deferred foreign-key check at commit (a `500`).
- **Order:** it is a card row, so it goes before any column row the transaction locks.
- **Stale instance (#1598):** `lock_card_for_write()` returns the row it locked, and `update_card` copies it onto the caller's pre-lock instance before `apply()`. `serializer.save()` writes every column of that instance, so without the re-read an archive or move committed between the caller's read and the lock was written back over: `archived_at` cleared and the card returned to its old cell with no `CardMovement` row. The archived guard and the `use_move_endpoint` cell check are re-run on the locked state.
- **Archive/unarchive (#1605):** both re-check `archived_at` on the locked row. A card archived (or restored) by a concurrent request in that window gets the existing no-op answer (`200` with the card, no second `CardMovement` row, broadcast, or hook). The `ARCHIVED`/`UNARCHIVED` movement row and the restore's column limit check use the card's cell as it is under the lock, not the cell a concurrent move took it out of. Both also read the set of cards the card blocks under that lock, as `delete_card` does, so a `blocks` relation created while they waited still gets its peer a `card.updated` frame (relation create locks both cards, which conflicts with the card lock).

### The response render is a delete race too (#1585)

- **REST:** the view's render callbacks for `move_card`, `archive_card` and `unarchive_card` raise `CardNotFound` (`404`) when the card is gone by the time they re-read it, rather than leaking `Card.DoesNotExist` as a `500`. Inside the service's transaction that rolls the write back with no broadcast. For the renders that run after `archive_card`'s transaction (and the `unarchive_card` no-op) the write is already committed and the answer is still `404`, because a `200` would have to invent a payload for a card that no longer exists.
- **Django admin card-child hooks (comment, checklist)** cannot surface a DRF `NotFound`, so they differ:
    - `save_model` takes `lock_card_for_write()` on the parent card before inserting the row (as the REST endpoints do, #1587) and answers a Django `Http404` if the card is already gone. A card delete can no longer fail the deferred foreign-key check at commit with a `500`.
    - The delete hooks look the card up by id rather than through the lazy `obj.card`, and skip the `card.updated` broadcast for a vanished card.
    - `delete_queryset` refetches every card before recording any event, so a card vanishing part-way cannot leave a partial broadcast.
    - `CardAdmin.save_model` likewise skips the broadcast for a vanished card.

### Container deletes (column, swimlane, board)

**Cards first (#1599).** Deleting a column, swimlane, or board cascades to its cards and has the same race. `ColumnViewSet`, `SwimlaneViewSet`, and `BoardViewSet` call `lock_cards_for_cascade()` first in their delete transaction.

- It locks every card the delete will cascade to, archived ones included, `FOR UPDATE` in one statement ordered by pk, before Django collects the cascade.
- A child write that already holds a card lock commits first, so the cascade sees its new rows and removes them. A child write that arrives later waits, finds the card gone, and answers `404`. Without the lock, the container delete failed its own deferred foreign-key check at commit with a `500`.
- Card rows are locked before the container row, in pk order, like `move_card`'s card lock, so the two queue rather than deadlock.
- The statement locks `FOR UPDATE OF` the card table only, so a filter that joins (the user admin's `board__owner`) does not also lock board rows.

**Entry columns (#1602).** The card statement locks the rows of its snapshot, so on its own it did not cover a card that entered the container after it ran:

- A card `create_card` inserted into the container, or one `move_card` moved into an empty cell of it (no container card to wait on), could commit before the collector's card `DELETE`. The delete then failed the same deferred foreign-key check at commit with a `500`.
- The other order was a `500` too: a create that queued behind the delete found its column gone (`Column.DoesNotExist`), and a create or move into a deleted swimlane failed its own deferred check.
- Locking the container row before the cards would close it but inverts the card -> column order above. The fix keeps that order and reuses the guarantee `move_card`'s re-check (#1567) rests on: every path that puts a card into a cell (`create_card`, `move_card` and the tools that call them, and the Django admin card form through `lock_card_cell_entry`, #1588) holds that cell's column row `FOR NO KEY UPDATE` until it commits.
- The destroy paths therefore pass `lock_cards_for_cascade(cards, entry_columns=..., boards=...)` the column rows a card can enter through (the deleted column itself, or every column of the board for a swimlane or board delete) and the board row(s).
- After the cards, the helper locks those columns in one pk-ordered `FOR NO KEY UPDATE` statement, the same mode and order as `move_card`'s column lock. Once it holds them no card can enter the container, and any card that entered before has committed, so the helper re-reads the container's cards. If one is not among the rows it locked, it rolls back to a savepoint (which releases that attempt's row locks) and repeats.
- It does not lock the newcomer in a second statement: that would take a card row after a column row, and could deadlock with a move of that card that holds it and waits on the column.
- A container that gains a card on every one of three attempts raises `ContainerChanged`, which the REST views answer with `409` (`code: container_changed`) and nothing deleted.
- **Entry side:** `create_card` and `move_card` re-check their target column (from the locked rows) and swimlane once they hold the column row, and answer `404` (`ColumnNotFound` / `SwimlaneNotFound`) for a container deleted while they waited. The Django admin card form makes the same checks and refuses the save with a form error. `move_card` re-reads the swimlane only when the card changes swimlane: a container the card is already in has to lock the card first, so the card lock already answers that case.

**Board row first (#1604, #1566, #1631).** Holding the entry columns needs the board row taken first.

- Column create, swimlane create, and swimlane reorder lock the board row `FOR UPDATE`; column reorder locks it `FOR NO KEY UPDATE` (#1566). Each does so *before* any column or swimlane row.
- A board delete that held the board's columns and only reached the board row at its final `DELETE` deadlocked against a column reorder that held the board row and waited on a column (the shape #1604 describes, which the early column lock made easy to hit).
- So every container delete locks its board row(s) first, pk-ordered, `FOR NO KEY UPDATE`, before the cards. That covers the REST column, swimlane, and board views, and the column, swimlane, board, and user admins. The mode conflicts with every board-row lock above, so a structure write and a container delete on one board queue whole, in either order, in the same board -> column order.
- It does not conflict with the `FOR KEY SHARE` a card insert takes on the board at commit. `FOR UPDATE` would, and a `create_card` holding a column would then wait on the board while the delete waits on that column.
- **`lock_board_row_or_404`:** a request that queued behind a board delete finds the board gone and answers `404` through it. Every board-row lock site in the views uses it: column and swimlane create and reorder, card and swimlane custom-field definition create, label create, saved-filter create, star, member add and removal, the invite caps (shareable link create and emailed invite send), and the invite join (#1631).
- The invite-only registration path takes the same board lock through `boards.invites.lock_invite_board` and answers `invite_invalid` rather than `404`. Definition update and delete, label update and delete, and column and swimlane update take the board row `FOR NO KEY UPDATE` and then their own row through `lock_board_and_row_or_404`. The Django column admin raises `Http404` instead.
- The board lock also closes the case where a column is created mid-delete. The REST column create and the Django column admin (on add and on edit) take the board row first, so no column can appear in, or be re-pointed at, the board after the delete's column statement, and `entry_columns` covers every column a card can enter through.
- No path takes a board-row lock after a card or column lock in the same transaction.

### The full lock order

| Transaction | Lock order |
|---|---|
| Container delete (column, swimlane, board; REST and admin; user admin for owned boards) | board row(s) `FOR NO KEY UPDATE` -> container's cards `FOR UPDATE` (one pk-ordered statement) -> entry column rows `FOR NO KEY UPDATE` (one pk-ordered statement) -> the collector's `DELETE`s |
| Card entry (`create_card`, `move_card`, `create_card_at_position`, admin card form) | (`create_card`, `create_card_at_position` and the admin card form: board row `FOR SHARE` first, #1632) -> moved card and cell cards (one pk-ordered statement) -> source and target column rows (one pk-ordered statement); `FOR KEY SHARE` on the board, column and swimlane only at commit. `create_card_at_position` (the MCP `create_card` tool with `position`, #1992) takes the target cell's cards and column in that order *before* it calls `create_card` and then `move_card` in one transaction. It re-reads the cell once it holds the column and retries from a savepoint if a card entered it; every lock the two calls take is then already held. A bare transaction around the two calls would hold the column from the create and then lock the cell's cards in the move (a card after a column), which deadlocks with a concurrent move in that cell |
| Card write and card delete | (`update_card` and the admin card form: board row `FOR SHARE` first, #1632) -> card row -> any column row |
| Labels and custom-field definitions a card create or update names (REST, MCP, admin card form) | never row-locked; re-read after the board row `FOR SHARE` above. Their `FOR KEY SHARE` from the M2M and value rows' foreign keys comes only at commit |
| User deactivation with board transfer (`AdminUserDeactivateView`) | user row `FOR NO KEY UPDATE` -> owned board rows, `UPDATE` in pk order (#1632; was `FOR UPDATE`, which deadlocked with a card write's commit-time `FOR KEY SHARE` on the user) |
| Card and swimlane custom-field definition reorder | board row `FOR NO KEY UPDATE` -> the definition rows `FOR UPDATE` (one pk-ordered statement) -> `bulk_update` |
| Column reorder | board row `FOR NO KEY UPDATE` -> every column row `FOR UPDATE` (pk order) |
| Column or swimlane create, swimlane reorder, custom-field definition create, invite caps | board row `FOR UPDATE` -> its own rows |
| Invite redemption (join view; invite-only registration, REST and OAuth) (#1631) | board row `FOR NO KEY UPDATE` (`lock_board_row_or_404` / `lock_invite_board`) -> invite row `FOR UPDATE` (or the registration claim's conditional `used_at` `UPDATE`) -> membership and redemption inserts |
| Board invite grant at email confirmation (`redeem_reserved_board_invites`, #1704) | board row `FOR NO KEY UPDATE` (`lock_invite_board`) -> invite row `FOR UPDATE` -> conditional `used_at` claim -> membership and redemption inserts. The group equivalent (`redeem_reserved_group_invites`) takes the group row `FOR NO KEY UPDATE` (`lock_invite_group`) -> invite row `FOR UPDATE`, the same order as the group invite redemptions below (#1638) |
| Group delete (`GroupViewSet.destroy`, #1638) | the group row and every subgroup row `FOR UPDATE` (one pk-ordered statement, `lock_group_subtree_for_delete`; the subtree is walked again under the locks until it stops growing) -> the collector's `DELETE`s and the boards' `SET_NULL` (memberships, invite rows, boards, then the group rows) |
| Board placed in a group: move-group, board `PATCH`/`PUT` naming `group`, board create with a group, group board create (#1638); board imports into a group (JSON, CSV, Trello) and the board admin save (#1719) | target group row `FOR KEY SHARE` (`lock_group_for_board_placement`) -> board row `FOR NO KEY UPDATE` (or the board insert) |
| Group invite redemption (join view `JoinGroupView.post`; invite-only registration, REST and OAuth, `validate_group_registration_token` / `redeem_group_registration_token`) (#1638) | group row `FOR NO KEY UPDATE` (`lock_invite_group`; the group id is read unlocked first) -> invite row `FOR UPDATE` (or the registration claim's conditional `used_at` `UPDATE`) -> membership insert |
| Group create under a parent and group parent change (`recheck_create_parent_under_lock`, `recheck_parent_under_lock`, #1690) | the parent's ancestor chain rows `FOR UPDATE` in one pk-ordered statement (a parent change includes the moved group's own row in that statement) -> reload and re-check the depth cap (and, for a parent change, the cycle rules) -> the `INSERT`/`UPDATE`. Only the ancestors read before the lock are locked |
| Other group writers (#1719): group label create and `PATCH`, group star | group row `FOR KEY SHARE` (`lock_group_for_child_write`) -> (label `PATCH`) that row `FOR NO KEY UPDATE` -> the `INSERT`/`UPDATE` |
| Group member role change and removal (`lock_membership_for_removal_or_demotion`) | the account rows of the group's admins and of the target `FOR NO KEY UPDATE` in one pk-ordered statement (`lock_member_accounts`, #1814) -> group row `FOR NO KEY UPDATE` (conflicts with the ownership transfer's `FOR UPDATE`, so the owner is read from the locked row) -> the group's admin rows and the target's row in one pk-ordered `FOR UPDATE` statement -> the owner and last-active-admin checks -> the `UPDATE`/`DELETE` |
| Group row writers and invite writers (#1719): board-defaults `PATCH`, invite revoke; invite link create and the emailed-invite send (the caps) | group row `FOR NO KEY UPDATE` (`lock_group_row`; the emailed-invite send keeps its `FOR UPDATE`) -> (revoke) invite row `FOR UPDATE` -> the `UPDATE`/`INSERT`. Ownership transfer takes the new owner's account row `FOR NO KEY UPDATE` -> its group row `FOR UPDATE` -> membership row (#1814); group `PATCH` keeps the #1690 row above |
| Board, column, swimlane, label and custom-field-definition UPDATE/DELETE writers (custom-field definition update and delete included, `FOR NO KEY UPDATE` through `lock_board_and_row_or_404`, not `FOR UPDATE`): board `PATCH`/`PUT`, share link enable/revoke, move-group, member add/role change/removal, label create, saved-filter create and star (board row only), column `PATCH`/`PUT`, swimlane `PATCH`/`PUT` and set-collapsed, label `PATCH`/`DELETE`, card and swimlane custom-field definition `PATCH`/`DELETE`; `BoardAdmin`, `ColumnAdmin`, `SwimlaneAdmin` (and the label and membership admins) saves | board row `FOR NO KEY UPDATE` -> (column, swimlane, label or definition writers) that row `FOR NO KEY UPDATE` -> the `UPDATE`/`DELETE` |

### Mail and invite-row rules

**No SMTP session runs under any of these locks.** A mail server with no `EMAIL_TIMEOUT` can hold a send open indefinitely, and every writer queued on the locked row waits with it.

- The invite-send view sends after its `atomic` block.
- Invite-only registration (`InviteRegisterView.create`) holds the row locks registration takes across account creation, so allauth's signup confirmation mail is rendered there but sent from `transaction.on_commit` (`accounts/adapter.py` `account_mail_deferred_to_commit`, #1639). A registration that rolls back sends no mail.
- Open-mode registration takes no such lock and still sends inline.
- If the deferred send fails, the account stands (`201`) and the user can ask for the mail again through `POST /api/v1/auth/registration/resend-email/` (`ResendEmailThrottle`, 10 per hour per IP; the SPA has no control for it).
- **Watch out:** under `EMAIL_VERIFICATION=mandatory` that `201` body still reads "Verification e-mail sent." when the send later fails.

**Board invites:** no path may lock a board row after it holds a board invite row in the same transaction. The board delete holds the board row and reaches the invite at its collector `DELETE`, so that order would deadlock against it. Invite revokes hold only the invite row and take no board lock (`BoardEvent.board_id` is a plain integer, not a foreign key).

### Group deletes and group writers

**Group invite rows (#1638).** The same rule holds for groups: no path may lock a group row after it holds a group invite row.

- **Before:** `GroupViewSet.destroy` called `group.delete()` with no lock. The collector read the group's memberships, waited on an invite row at its `DELETE`, and only reached the group row last. A join, invite-only registration, or confirmation grant that held that invite row and inserted a `GroupMembership` under it made the delete fail its deferred foreign key at commit (a `500`). A grant, which already took the group row first, deadlocked against it instead.
- **Now:** the delete locks the group row and its subgroups `FOR UPDATE` before the collector runs. Subgroups are included because the delete cascades to them, and an invite on a subgroup races a parent delete the same way. It is one pk-ordered statement, the order the parent-change writer locks a chain in, so the first statement cannot deadlock against a single re-parent. The re-walk rounds that lock subgroups found afterwards take them after higher-pk rows are held, and can in theory still contend with a second re-parent in flight.
- Every redemption takes the group row `FOR NO KEY UPDATE` before the invite row. A redemption and a delete therefore queue whole. A delete behind a redemption removes the new membership with the group (`204`). A redemption behind a delete finds the group gone and answers `404` (join), `invite_invalid` (registration), or grants nothing (confirmation), with nothing written or broadcast.
- The delete re-reads the owner and parent from the locked row. A delete that queued behind an ownership transfer answers `403`, a second delete of the same group answers `404` without a second `group.deleted` event, and the event reaches the parent the group actually had.
- **Group -> board is the order for boards too.** The delete reaches a board in its subtree only at the collector's `SET_NULL`, and a board's `group` foreign key is deferred. A move-group or group-changing `PATCH` that held the board row and asked for the target group only at commit deadlocked against the delete (a `500`), and any writer placing a board in a group being deleted failed that foreign key at commit (a `500`). Each such writer now takes the target group row `FOR KEY SHARE` before the board row, the mode the foreign key check takes anyway, so it conflicts only with the delete and other `FOR UPDATE` holders of the group row. A writer behind a delete answers `404` (move-group, group board create) or the serializer's unknown-group `400` (board create and `PATCH`/`PUT`).
- The consume-once claims are unchanged.
- **Tests:** `groups/tests/test_group_invite_vs_group_delete.py` (PostgreSQL deterministic interleavings, both orders, for join, subgroup join, registration, confirmation grant, move-group, board `PATCH`, board create and group board create, plus the subtree re-walk).

**Other group writers (#1719).** #1638 left some group writers out. Each inserted or updated a row pointing at the group (or the group row itself) with no group lock. Racing a delete of that group, they:

- failed the row's deferred foreign key at commit,
- raised from a row the delete had removed (`DoesNotExist` in the ownership transfer and the group `PATCH`, `DatabaseError` from the invite revoke's `save(update_fields=...)`), or
- had `save()` fall back to an `INSERT` when its `UPDATE` matched no row. That re-created a group label or a membership under the deleted group (a `500` at commit) or, for the board-defaults `PATCH`, silently re-created the deleted group itself, empty and with no members, and answered `200`.

Every other case was a `500`. Now every one of them locks the group row before it writes:

| Writer | Group-row lock |
|---|---|
| Label create or `PATCH`, star | `FOR KEY SHARE` (`lock_group_for_child_write`, the mode the foreign key check takes) |
| Board-defaults `PATCH` | `FOR NO KEY UPDATE` (`lock_group_row`), then reloads the row so `save()` cannot write a stale name back |
| Invite revoke | `FOR NO KEY UPDATE` (`lock_group_row`), ahead of the invite row as redemptions take them |
| Invite link create | `FOR NO KEY UPDATE`; it conflicts with itself, so it serializes its cap count without blocking the `FOR KEY SHARE` writers |
| Emailed-invite send | keeps the `FOR UPDATE` it already took for its cap |
| Member role change or removal | the admins' and the target's account rows `FOR NO KEY UPDATE` (#1814), then the group row `FOR NO KEY UPDATE`, then the membership rows; refuses to remove or demote the owner or the last active admin under those locks |
| Board imports into a group, board admin save | `lock_group_for_board_placement` before the board insert or the board row |

- The ownership transfer already locked the group row. The group `PATCH` and a subgroup create lock it with its ancestor chain (#1690). They now answer a row that is gone once they hold the lock: `404` for the transfer and the `PATCH`, and for a subgroup create the unknown-parent `400` in its documented `{"parent": [...]}` shape (it was a bare list).
- A label `PATCH` also locks its own row after the group row, so one queued behind a delete of that row answers `404` instead of re-creating it.
- A writer behind a delete answers `404` (the import's unknown-group answer; the admin raises `Http404`) with nothing written. A delete behind a writer waits for it and then cascades or detaches what it wrote.
- **Seed commands take no group lock.** Under `--reset-database`, `seed_demo_data` creates its demo group and the rows that point at it in one transaction. A plain run commits the group on its own first, so its owner and site admins could in principle see it before those rows are written, but nothing deletes the demo group concurrently in practice. `seed_template_boards` places no board in a group.
- **Yes, but:** each writer checks the caller's group-admin standing before it takes the group lock, so a demotion that commits in that window can still let one write through. This is accepted because an invite's sender standing is re-checked at preview and redemption (#1490).
- **Tests:** `groups/tests/test_group_writers_vs_group_delete.py` (PostgreSQL deterministic interleavings, both orders, for every writer above).

**Card admin delete:** takes no board or column lock, because a card delete has no container a card can enter.

### Board, column, and swimlane writers (#1602, #1631, #1632)

**The problem.** A container delete holds the board row from the start. A writer that went straight to its `UPDATE` queued behind the whole cascade (the board `UPDATE` takes `FOR NO KEY UPDATE` on the board row itself, a column `UPDATE` on a column row the delete holds) and then found its row gone. `serializer.save()` and a full `save()` fall back to an `INSERT` when the `UPDATE` matches no row. That re-created the deleted board with no columns or members, or tripped an `IntegrityError` the column view reported as a misleading `400`. `save(update_fields=...)` raised instead (a `500`).

**The fix.** Each writer takes the board row (`lock_board_row_or_404(board, no_key=True)`), and a column or swimlane writer then its own row (`lock_board_and_row_or_404`), before saving.

- A writer behind a delete answers `404` (the admin raises `Http404`, through `_lock_board_for_admin_save`) and writes nothing.
- `FOR NO KEY UPDATE` is the mode the `UPDATE` takes anyway, so it adds no new conflict, and it does not block a card insert's `FOR KEY SHARE`.
- Move-group saves with `update_fields`.
- Label create, saved-filter create, and star take the board row (`FOR NO KEY UPDATE`), so they queue with a board delete in both orders. A row committed between the delete's cascade read and its `DELETE` would otherwise fail the delete's deferred foreign key at commit, and a label created after the delete reported a misleading `400`.
- A column, swimlane, or board `DELETE` that queued behind another delete of the same object re-checks, once it holds the locks, that the board and the object still exist. It answers `404` without storing or broadcasting a second deletion event (`require_present_or_404`).
- The column, swimlane, label, and custom-field-definition `PATCH`/`PUT` reload the row under the lock before saving, like the board `PATCH`.
- Label and custom-field-definition writers take the same two locks (`lock_board_and_row_or_404` with the label or definition model). Their `PATCH`, queued behind a `DELETE` of the same row, updated no row and `save()` inserted it again under the same pk, re-creating the deleted label or definition. The `DELETE` takes the locks too, so a second delete or a delete after an update answers `404` rather than broadcasting twice.
- Member add and role change (`members`) and member removal (`remove_member`) take the board row, so they queue with each other and with a board delete and answer `404` once the board is gone, not a `500` from the deferred board foreign key at commit. A role change queued behind a removal re-creates the membership as a new add, which is the result of the two in sequence.
- The board `PATCH` reloads the board under the lock before saving. `save()` writes every column, and the snapshot read before the lock could overwrite fields another request changed (the share link fields, the group) while the `PATCH` queued, so the `PATCH` now applies only the fields the request sent.
- `move_group` reads the group the board is leaving from the locked row, so the `board.deleted` event reaches the group it actually left.
- `lock_board_and_row_or_404` also scopes the row to the board, so a pk from another board is `404`.

**Left as they were**, because they cannot re-create a deleted board, column, or swimlane:

- Column and swimlane reorders use `bulk_update`, which matches nothing once the rows are gone (the card and swimlane custom-field definition reorders now take the board row for #1632, below).
- The user-admin board transfer is a queryset `update()` (same).
- The board saved in group board create is created in that request.
- The invite link revoke already locks its row (`select_for_update`) and answers `404` once it is gone.
- Group membership role edits are not board-scoped and are not covered here.

**Invite redemption (#1631)** (the join view and invite-only registration, REST and OAuth) takes the board row `FOR NO KEY UPDATE` (`lock_board_row_or_404` in the join view, `lock_invite_board` on the registration path) before it locks the invite row. It reads the invite's board id unlocked first.

- A redemption that held only the invite row and inserted the membership and redemption rows under it made a board delete, waiting on that invite at its collector `DELETE`, fail its deferred foreign keys at commit. Locking the board after the invite would deadlock against it.
- A redemption queued behind a board delete answers `404` (join) or `invite_invalid` (registration) with nothing written or broadcast.
- The consume-once claim is unchanged, still taken under the invite row lock (or the conditional `used_at` update).
- The group side, a group invite redemption racing a group delete, is #1638 (above).

**Labels and definitions named by a card write (#1632).** A card create or update that names labels (`label_ids`) or custom-field definitions (`custom_field_values`) resolved them at validation, before its transaction. A label or definition `DELETE` committing in between left the M2M or value row it inserts pointing at a missing row: a `500` from the deferred foreign key at commit.

- `create_card` and `update_card` now take the board row `FOR SHARE` as the first lock of their transaction (`lock_board_for_card_write`), before the card row and any column row. `CardSerializer` re-reads the named rows under it; one already gone answers `400`, as a request naming an unknown id always did.
- Every label or definition deleter takes the board row `FOR NO KEY UPDATE` first. That covers the REST `DELETE`s and the label admin (single and bulk, through `lock_board_and_row_or_404`, `_lock_board_for_admin_save` and `_lock_boards_then_rows`), and container, board, and user deletes through `lock_cards_for_cascade(boards=...)`. It conflicts with `FOR SHARE`, so it either committed before the re-read or queues behind the whole card write and then cascades what it wrote.
- `FOR SHARE` does not conflict with itself or with `FOR KEY SHARE`: card writes on one board do not queue behind each other, and a card insert's commit-time `FOR KEY SHARE` on the board is unaffected. It does make a card create or update and a board-row writer (board `PATCH`, column reorder, label create, and the rest of the table) queue whole, in either order.
- **Watch out:** the cost runs both ways, and there is no lock timeout. A card create or update waits for every in-flight board-row writer on its board (star, saved-filter create, label create, member add, role change and removal, board `PATCH`, structure writes and reorders, and a column, swimlane, or board delete for its whole cascade), and those wait for in-flight card writes.
- **Why it is deadlock-free:** the board row is the card transaction's first lock; no path takes a board-row lock after a card or column lock; nothing in a card create or update writes the board row, so two `FOR SHARE` holders never upgrade into each other; and the label and definition rows are never row-locked by a card write, only read.
- **The remaining edge is the user row.** At commit a card write takes `FOR KEY SHARE` on the users its foreign keys name (activity actor, `created_by`, `assignee`), so any transaction that holds a user row `FOR UPDATE` and then locks or `UPDATE`s a board row closes a cycle with it.
    - The user deactivation endpoint did exactly that: it locked the user `FOR UPDATE` and then `UPDATE`d the boards it transfers, so deactivating a board owner with a card write of theirs in flight deadlocked (a `500`). It now locks the user `FOR NO KEY UPDATE`, which does not block `FOR KEY SHARE`, as the user admin delete already did (#1616), and transfers the boards in pk order.
    - Every other user-row `FOR UPDATE` holder (password, login, token, email change, the admin user `PATCH` and the user admin save, `set_site_admin`, `ensure_site_admin`, the demo seed's account reset) touches no board, card, or column row. Their invite link revocations lock invite link rows and append `BoardEvent` rows, which have no foreign key to the board.
    - The user admin delete locks its targets `FOR NO KEY UPDATE`, then the owned boards (so it queues behind a card write on one of them), and takes `FOR UPDATE` on the users only after that.
- **Abandoned first attempt:** locking the label and definition rows instead. It came after the column row on create but before it on a weight-raising update, so a create and an update naming the same label deadlocked.
- The Django admin card form takes the same lock (stored and submitted board, pk order) at the start of `clean()`, before the card and column rows, and re-reads the `labels` it chose. A label deleted meanwhile is a form error.
- The card and swimlane custom-field definition reorders take the board row `FOR NO KEY UPDATE` and then lock the definition rows in pk order. Before, `bulk_update` locked them in scan order with no board lock, and a card or swimlane write holding `FOR KEY SHARE` on one definition at commit while waiting on another could close a cycle with it.
- Swimlane create and update re-read their `custom_field_values` definitions after the board row (`_require_live_swimlane_definitions`). Before, a swimlane create racing a definition delete failed the value rows' foreign key at commit, which it reported as a misleading `400` name collision.
- **Seed `--wipe`** (`seed_demo_data`, `seed_template_boards`) deletes through `delete_boards_locked`, which takes the same locks as the board destroy view, because the demo cronjob runs them against a live instance. The helper resolves the board set to pks once, inside its transaction, and uses those pks for every lock statement and the final `DELETE`, so a board created with the same name between statements cannot be deleted unlocked.

### Django admin deletes (#1603, #1712)

The card, column, swimlane, and board admins, and the user admin (a user delete cascades to the boards they own and those boards' cards), take the same lock.

- Each `delete_model` and `delete_queryset` runs `lock_cards_for_cascade()` and the delete inside one `transaction.atomic()`. The outer transaction matters for bulk admin actions, which Django does not wrap, so a lock taken per object would be released before the delete.
- The column, swimlane, board, and user admins also pass `entry_columns` and `boards` (#1602), so a card created in, or moved into, the container mid-delete is covered, and the board row is taken first, as on the REST paths. The card admin passes neither: a card delete has no container a card can enter.
- The rare `ContainerChanged` after three lost attempts is caught at the view level (`ContainerChangedAdminMixin`), not in `delete_model` or `delete_queryset`, because Django prints its success message after those return. A single delete shows the error and returns to the object's change page. A bulk `delete_selected` runs in one transaction, so the deletion log entries Django writes before `delete_queryset` roll back too, and it returns to the changelist with the error. Nothing is deleted in either case.
- The `board.deleted` event, from the REST board `DELETE` and the board admin's single and bulk delete, reads the board's group from the locked row (#1712), so a move-group that commits while the delete queues does not leave it going to the group the board already left.

## What stays in the view

Nothing under `boards/services/` imports `rest_framework`, reads a request, or builds a response. The view adapter keeps:

- **Parsing**, mostly. `?force` becomes a `bool`. The exception is `version`, which the REST move adapter passes through raw to `move_card`. Since 1.3 `update_card` also accepts `expected_version`, but only the MCP `update_card` tool sends it; the REST `PATCH`/`PUT` adapter passes none (#1974). *When* the "version must be an integer" `400` is raised is part of the frozen contract (after the role allow-list, the card lookup, and the assignment gate), so the coercion lives in the service. Parsing it in the adapter turns a `403` into a `400` for a caller who sent both a bad version and a request they were not allowed to make.
- **Field validation** at the serializer boundary. `create_card` and `update_card` take a callable that performs the already-validated write (`serializer.save()` for the HTTP adapter). `CardSerializer`'s querysets are board-scoped, so a cross-board column, swimlane, label, or assignee id is already a `400` before the service is reached.
- **Serialization.** Each function takes a `render` callable and invokes it *inside* the transaction, because the REST response body and the WebSocket payload are deliberately the same dict. Re-serializing after commit would cost a second multi-query fetch and let a concurrent writer land between the write and the read.

**Yes, but:** `render` is the one deliberate compromise in the boundary. The service stays serializer-agnostic, yet whatever `render` returns *is* the `card.*` WebSocket frame and change-feed row, which [the WebSocket contract](../api/websockets.md#card-events) fixes as a `CardSerializer` card (`{card[, movement]}` for a move). An adapter that needs a different return shape renders the contract and keeps its own shape on the side, as the MCP tools do with `_BroadcastRender.tool_card` (*1.2, #1926*: they returned their own shape from `render`, and it reached the wire).

## Errors

`boards/services/errors.py` holds one class per failure mode, each carrying the exact HTTP status and response body its endpoint returned before the extraction. A view adapter is a single clause:

```python
def handle_exception(self, exc):
    if isinstance(exc, CardServiceError):
        return Response(exc.body(), status=exc.status)
    return super().handle_exception(exc)
```

The bodies are a frozen contract, so they live in one module rather than being reassembled in the views. The card API returns five mutually incompatible `409`/`403` shapes:

- `wip_limit_exceeded` and `weight_limit_exceeded` carry no `detail` key at all.
- `wip_hard_blocked` carries both `detail` and `code`.
- The move assignee gate is the only `403` in the card API with a `code`.

The web client reads those field names directly, so converging the shapes needs a major version bump. `backend/boards/tests/test_card_error_bodies.py` pins every one by exact dictionary equality.

**Watch out:** the adapter does **not** wrap these in a DRF `APIException`. DRF coerces every value in an exception detail to a string, which would turn `current_count`, `wip_limit`, `card_weight`, and `current_version` into strings and break clients that compare them numerically.

`boards/services/errors.py` is **not** an extension point and carries no stability guarantee, unlike `boards/hooks.py`. The hierarchy is expected to change when the error bodies are converged.

## Roles

`boards/permissions.py` exposes two resolvers over one shared precedence ladder:

| Function | Use |
|---|---|
| `get_board_role(user, board)` | one board |
| `get_board_roles(user, boards)` | a list of boards, in a fixed two queries |

Resolving a role per board is an N+1 on any board that derives its role from a group. That is why the bulk form exists, and why re-implementing the ladder to dodge the N+1 produced the MCP fork. Both resolvers delegate to the same private helpers; only the way they *load* memberships differs. Boards passed to `get_board_roles` must be loaded with `GROUP_ANCESTOR_SELECT_RELATED` applied, or the ancestor walk reintroduces the N+1 one level down.

`can_modify_others_content()`, the ownership gate, also lives in `permissions.py` so a service can call it without importing from `boards.views`.

### The `role` parameter fails closed

Every service function takes an optional `role`, so an adapter that has just resolved it (`get_board_for_user()` does, as part of its own access check) does not pay twice. On a group-inherited board the second resolution is a real query.

A parameter that carries authorization state is safe only if a wrong value cannot be believed. Both resolvers leave a memo on the board instance recording which role they resolved and for whom, and the service accepts a supplied role only when it matches that memo. Anything else is discarded, logged, and the role is derived from the database instead. Two mistakes are therefore impossible: passing `"admin"` outright, and (the likelier one, now that `get_board_roles` returns a `{board_id: role}` dict) indexing that dict with the wrong board id. Both just cost the query the parameter existed to save.

The memo is set by the resolvers alone and is never an input. A caller with no already-resolved role passes `None`, which is always correct.

## Write paths that remain divergent

Two paths deliberately do **not** go through the card service. Both are documented divergences, not oversights. (The operator seed commands `seed_demo_data` (including `--demo-site`), `seed_template_boards`, and `benchmark` also write cards directly with `Card.objects.create`/`bulk_create`. They are exempt from WIP and weight limits for the same reason as import: they build a board as designed, which may be over its limits. They are management commands, not an API write path.)

**Import / export** (`boards/views/import_export.py`) creates cards with `bulk_create` into a board it has just created. It:

- does not enforce WIP or weight limits, by design: an import restores a board as exported, and the sample boards each ship one over-WIP column (#1428)
- does not compact positions
- writes one `board.created` broadcast instead of per-card events
- fires no card mutation hooks

A per-card service in a loop would mean O(n) round trips and a row lock per card on a 500-card import. Also, `bulk_create` does not emit `post_save`, so importing movement history does not notify assignees. Routing import through a service that creates `CardMovement` rows individually would send a notification per imported movement.

**Django admin** (`boards/admin.py`, `CardAdmin.save_model`) broadcasts card events and bumps `version` by one on a change save (since 1.3, #2040; computed from the row it holds `FOR UPDATE`, the lock `update_card` and `move_card` bump under, so a request carrying the pre-edit version gets `409 version_conflict`), but skips the `CardMovement` audit trail, the board-level RBAC check, and the hooks. An admin moving a card between columns therefore leaves no audit trail. WIP and weight limits and `allow_card_creation` *are* applied since 1.2: `CardAdminForm.clean()` calls the service's own `enforce_column_limits()` and reports a refusal as a form error, with no `force` override (#1428). Routing the rest through the service is the strongest candidate to migrate next (a single call site).

## A service that is not a transition: `custom_fields`

`boards/services/custom_fields.py` (#371) is the second module in the package. It deliberately does not follow the `cards.py` shape: it owns no transaction, role check, or broadcast, because writing a card's custom field values is part of the card update that contains it, not a transition of its own.

**How it works:**

- Validation and per-type casting stay at the serializer boundary (`CustomFieldValuesField`).
- The **diff** (which submitted values actually changed) and the `custom_field_value_changed` signal fan-out live in the service. That keeps a client echoing back the representation it was given from firing an enterprise audit-log entry for a change nobody made.
- It is called from `CardSerializer.create`/`update`, inside `update_card`'s and `create_card`'s transaction, so the values roll back with the card and the deferred `card.updated` broadcast already reflects them.

## Adding to this layer

Swimlane and column reorder and the other structural mutations are slated to follow, which is why `boards/services/` is a package rather than a single module. When adding a transition:

1. Put the invariants in a service function; leave parsing, validation, and rendering to the caller.
2. Add a class to `errors.py` for each new failure mode — never build a response body in a view.
3. Reach `broadcast` and `hooks` through the **module object** (`from .. import broadcast as _broadcast`). The test suite patches `boards.broadcast.broadcast_board_event` at its source module, and a direct-name import binds a reference the patch cannot reach — so tests that patch only to suppress the channel layer would silently start broadcasting for real.
4. Register hook callbacks by reading `hooks.CARD_MUTATION_HOOKS` inside the `on_commit` callback. Enterprise code appends to that list in place; a copy taken at import time would miss late registrations, and rebinding the attribute would drop every enterprise handler. Each handler runs in isolation (`_run_hooks`): an exception is logged (handler name, ids, event type, exception class only) and swallowed, because the write is already committed and a 500 would invite a duplicate-creating retry. Handlers must therefore handle their own failures; they cannot veto or roll back the write.
5. When adding a writer (an adapter), make its `render` return the payload the REST adapter broadcasts for the same event, never its own response shape: the return value is the WebSocket frame and the change-feed row. Keep any different response shape on the side, as `mcp_server.tools._BroadcastRender` does, and test the stored `BoardEvent` row against `render_card_payloads` (see `BroadcastPayloadShapeTests`).
6. Add a query budget to `CardMutationQueryCountTests`. Mutation budgets are `measured + 3`, tighter than the 2× used for read endpoints, because they have to catch a constant regression rather than a row-scaling one.

## Frozen asymmetries

Three things in this layer look like bugs and are contract. Do not "fix" them without a major version bump:

- `unarchive` broadcasts the WebSocket event `card.unarchived` but fires the hook event `card.restored`. Both names are independently frozen.
- `card.archived` broadcasts only `{"card_uid": ...}` while `card.unarchived` broadcasts the whole card. A client only needs to drop an archived card from its view.
- `update_card` and `delete_card` reject an archived card; `move_card` accepts one. The move endpoint has always read through the unfiltered manager, so archiving never froze a card's position — a restored card returns to wherever it was put.
- The error bodies described above.
