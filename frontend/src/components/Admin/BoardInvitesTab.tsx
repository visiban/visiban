import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { getAdminBoardInviteLinks, revokeAdminBoardInviteLink } from "../../api/auth";
import { INVITE_ROLE_LABELS, INVITE_STATUS_STYLES } from "../../constants/invites";
import { useConfirmFocusReturn } from "../../hooks/useConfirmFocusReturn";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import type { AdminBoardInviteLink, AdminBoardInviteStatusFilter } from "../../types";
import SingleSelectDropdown from "../Common/SingleSelectDropdown";

/**
 * Admin → Board Invites (#439): every board's invites — emailed and shareable
 * — in one paginated table, with revoke. The site-admin counterpart of the
 * per-board list in Board Settings → Members, for a leaked link or an audit.
 */

const STATUS_OPTIONS: { value: AdminBoardInviteStatusFilter; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "used", label: "Used" },
  { value: "expired", label: "Expired" },
  { value: "revoked", label: "Revoked" },
  { value: "all", label: "All" },
];

function statusStyle(status: string): string {
  return INVITE_STATUS_STYLES[status as keyof typeof INVITE_STATUS_STYLES] ?? INVITE_STATUS_STYLES.revoked;
}

const ALREADY_USED_REVOKE_ERROR = "This invite is no longer pending, so it can't be revoked.";
const GENERIC_REVOKE_ERROR = "Could not revoke invite.";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export default function BoardInvitesTab() {
  const [statusFilter, setStatusFilter] = useState<AdminBoardInviteStatusFilter>("pending");
  const [rows, setRows] = useState<AdminBoardInviteLink[]>([]);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [revokingId, setRevokingId] = useState<number | null>(null);
  const [revokeError, setRevokeError] = useState<{ id: number; message: string } | null>(null);
  const revokeTriggerRef = useConfirmFocusReturn(confirmId);
  // A revoke that removes its own row (or its Revoke button) leaves nothing
  // for useConfirmFocusReturn to return to: focus moves to the heading.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [focusHeading, setFocusHeading] = useState(false);
  useEffect(() => {
    if (!focusHeading) return;
    headingRef.current?.focus();
    setFocusHeading(false);
  }, [focusHeading]);

  // Escape cancels an open revoke prompt before AdminPage's priority-0
  // Escape-to-navigate handler can leave the page (#1238).
  useEscapeStack(() => {
    if (confirmId !== null && revokingId === null) { setConfirmId(null); setRevokeError(null); return; }
    return false;
  }, 40);

  const fetchRows = useCallback(async (filter: AdminBoardInviteStatusFilter, offsetVal: number) => {
    setLoading(true);
    setError(false);
    try {
      const data = await getAdminBoardInviteLinks({ status: filter, offset: offsetVal });
      setRows(data.results);
      setTotal(data.count);
      // The server's page size keeps the footer in sync if its default changes.
      setPageSize(data.page_size);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchRows(statusFilter, offset);
  }, [fetchRows, statusFilter, offset]);

  const changeOffset = (next: number) => {
    setRevokeError(null);
    setConfirmId(null);
    setOffset(next);
  };

  const handleFilterChange = (value: AdminBoardInviteStatusFilter | null) => {
    if (!value || value === statusFilter) return;
    setConfirmId(null);
    setRevokeError(null);
    setOffset(0);
    setStatusFilter(value);
  };

  const handleRevoke = async (row: AdminBoardInviteLink) => {
    // In-flight guard (#1421): a second click must not send another DELETE.
    if (revokingId !== null) return;
    setRevokingId(row.id);
    setRevokeError(null);
    try {
      const updated = await revokeAdminBoardInviteLink(row.id);
      setConfirmId(null);
      if (statusFilter === "pending") {
        // No longer pending: it leaves this view.
        const remaining = rows.filter((r) => r.id !== row.id);
        setTotal((t) => Math.max(0, t - 1));
        if (remaining.length === 0 && offset > 0) {
          // The page emptied: step back a page rather than show "No pending
          // board invites." while earlier pages still hold some.
          setOffset(Math.max(0, offset - pageSize));
        } else {
          setRows(remaining);
        }
      } else {
        setRows((prev) => prev.map((r) => (r.id === row.id ? updated : r)));
      }
      setFocusHeading(true);
    } catch (err: unknown) {
      const httpStatus = (err as { response?: { status?: number } }).response?.status;
      if (httpStatus === 400) {
        // Redeemed or revoked elsewhere while the prompt was open: say so and
        // show the row's real state.
        setConfirmId(null);
        await fetchRows(statusFilter, offset);
        setRevokeError({ id: row.id, message: ALREADY_USED_REVOKE_ERROR });
        setFocusHeading(true);
      } else {
        // Leave the prompt open with both buttons re-enabled so it can be retried.
        setRevokeError({ id: row.id, message: GENERIC_REVOKE_ERROR });
      }
    } finally {
      setRevokingId(null);
    }
  };

  const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 1;
  const currentPage = pageSize > 0 ? Math.floor(offset / pageSize) + 1 : 1;
  const emptyMessage = statusFilter === "all" ? "No board invites yet." : `No ${statusFilter} board invites.`;

  return (
    <div className="flex flex-col gap-4">
      <h2 ref={headingRef} tabIndex={-1} className="text-fg text-lg font-semibold focus:outline-none">Board Invites</h2>

      <div className="flex items-center gap-2">
        <SingleSelectDropdown<AdminBoardInviteStatusFilter>
          label="Status"
          ariaLabel="Status"
          options={STATUS_OPTIONS}
          selected={statusFilter}
          onChange={handleFilterChange}
        />
      </div>

      {/* A revoke that lost to a redemption closes its prompt, so its outcome
          is announced here, always mounted. */}
      <div role="status" aria-live="polite" aria-atomic="true">
        {revokeError?.message === ALREADY_USED_REVOKE_ERROR && (
          <p className="text-sm text-danger">{revokeError.message}</p>
        )}
      </div>

      {loading ? (
        <div className="text-fg-tertiary text-sm">Loading…</div>
      ) : error ? (
        <div>
          <p role="alert" className="text-sm text-danger mb-2">Failed to load board invites.</p>
          <button
            type="button"
            onClick={() => void fetchRows(statusFilter, offset)}
            className="text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover px-2 py-1 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Try again
          </button>
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-fg-muted">{emptyMessage}</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface text-fg-tertiary text-xs uppercase tracking-wide">
                  <th className="text-left px-4 py-2.5 font-medium">Board</th>
                  <th className="text-left px-4 py-2.5 font-medium">Role</th>
                  <th className="text-left px-4 py-2.5 font-medium">Delivery</th>
                  <th className="text-left px-4 py-2.5 font-medium">Status</th>
                  <th className="text-left px-4 py-2.5 font-medium">Expires</th>
                  <th className="text-left px-4 py-2.5 font-medium">Created by</th>
                  <th className="text-left px-4 py-2.5 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const pending = row.status === "pending";
                  const isConfirming = confirmId === row.id;
                  const inFlight = revokingId === row.id;
                  return (
                    <Fragment key={row.id}>
                      <tr className="border-t border-line-subtle hover:bg-surface/50 transition">
                        <td className="px-4 py-2.5 text-fg">
                          <div className="max-w-[14rem] truncate" title={row.board_name}>{row.board_name}</div>
                        </td>
                        <td className="px-4 py-2.5 text-fg-secondary">{INVITE_ROLE_LABELS[row.role] ?? row.role}</td>
                        <td className="px-4 py-2.5 text-fg-secondary">{row.delivery === "email" ? "Email" : "Link"}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className={`px-2 py-0.5 text-xs rounded-full ${statusStyle(row.status)}`}>
                              {capitalize(row.status)}
                            </span>
                            {pending && !row.can_register && (
                              <span
                                className="px-2 py-0.5 text-xs rounded-full border border-line text-fg-tertiary"
                                title="New people can't create an account from this invite on this site."
                              >
                                Existing accounts only
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-fg-muted">{formatDate(row.expires_at)}</td>
                        <td className="px-4 py-2.5 text-fg-secondary">
                          {row.created_by_username ?? (
                            <span className="text-fg-muted" title="Account removed">
                              <span aria-hidden="true">—</span>
                              <span className="sr-only">Account removed</span>
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          {pending && !isConfirming && (
                            <button
                              ref={revokeTriggerRef(row.id)}
                              type="button"
                              onClick={() => { setRevokeError(null); setConfirmId(row.id); }}
                              aria-label={`Revoke invite ${row.prefix} for ${row.board_name}`}
                              className="text-xs text-danger hover:text-danger transition rounded focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
                            >
                              Revoke
                            </button>
                          )}
                        </td>
                      </tr>
                      {isConfirming && (
                        <tr>
                          <td colSpan={7} className="px-4 pb-2.5">
                            <div role="status" aria-live="polite" aria-atomic="true" className="flex flex-wrap items-center gap-2 text-xs">
                              <span className="text-fg-tertiary">
                                {row.delivery === "email"
                                  ? `Revoke this invite to ${row.board_name}? The person it was emailed to will no longer be able to join.`
                                  : `Revoke this invite link to ${row.board_name}? Anyone holding it will no longer be able to join.`}
                              </span>
                              <button
                                type="button"
                                onClick={() => void handleRevoke(row)}
                                disabled={inFlight}
                                className="text-danger hover:text-danger font-medium transition disabled:opacity-40 rounded focus:outline-none focus:ring-2 focus:ring-danger-emphasis"
                              >
                                Confirm
                              </button>
                              <button
                                type="button"
                                onClick={() => { if (inFlight) return; setConfirmId(null); setRevokeError(null); }}
                                disabled={inFlight}
                                className="text-fg-tertiary hover:text-fg transition disabled:opacity-40 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                              >
                                Cancel
                              </button>
                              {revokeError?.id === row.id && revokeError.message === GENERIC_REVOKE_ERROR && (
                                <p className="basis-full text-xs text-danger mt-1">{revokeError.message}</p>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-sm text-fg-tertiary">
            <span>{total} {total === 1 ? "invite" : "invites"}</span>
            {totalPages > 1 && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => changeOffset(Math.max(0, offset - pageSize))}
                  disabled={offset === 0}
                  className="px-2 py-1 text-xs text-fg-tertiary hover:text-fg hover:bg-surface-hover rounded disabled:opacity-40 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  ← Prev
                </button>
                <span className="text-xs">
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => changeOffset(Math.min((totalPages - 1) * pageSize, offset + pageSize))}
                  disabled={currentPage === totalPages}
                  className="px-2 py-1 text-xs text-fg-tertiary hover:text-fg hover:bg-surface-hover rounded disabled:opacity-40 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
                >
                  Next →
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
