import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { getAdminBoardInviteLinks, revokeAdminBoardInviteLink } from "../../api/auth";
import { INVITE_ROLE_LABELS } from "../../constants/invites";
import { useConfirmFocusReturn } from "../../hooks/useConfirmFocusReturn";
import { useConfirmAnnouncement } from "../../hooks/useConfirmAnnouncement";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import type { AdminBoardInviteLink, AdminBoardInviteStatusFilter } from "../../types";
import { Button, EmptyState, FilterPill, InlineConfirm, ListWell, PageHeading, StatusPill, type StatusTone } from "../Page";

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

const STATUS_TONE: Record<string, StatusTone> = { pending: "pending", used: "on_track", expired: "at_risk", revoked: "off_track" };

function statusTone(status: string): StatusTone {
  return STATUS_TONE[status] ?? "off_track";
}

const ALREADY_USED_REVOKE_ERROR = "This invite is no longer pending, so it can't be revoked.";
const GENERIC_REVOKE_ERROR = "Failed to revoke invite. Please try again.";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export default function BoardInvitesTab({ onPendingCount }: { onPendingCount?: (n: number) => void } = {}) {
  const [statusFilter, setStatusFilter] = useState<AdminBoardInviteStatusFilter>("pending");
  const [rows, setRows] = useState<AdminBoardInviteLink[]>([]);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const pendingTotalRef = useRef<number | null>(null);
  const [error, setError] = useState(false);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [revokingId, setRevokingId] = useState<number | null>(null);
  const [revokeError, setRevokeError] = useState<{ id: number; message: string } | null>(null);
  const revokeTriggerRef = useConfirmFocusReturn(confirmId);
  const confirmingRow = confirmId === null ? undefined : rows.find((r) => r.id === confirmId);
  useConfirmAnnouncement(
    !confirmingRow
      ? null
      : confirmingRow.delivery === "email"
        ? `Revoke this invite to ${confirmingRow.board_name}? The person it was emailed to will no longer be able to join.`
        : `Revoke this invite link to ${confirmingRow.board_name}? Anyone holding it will no longer be able to join.`,
  );
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
      if (filter === "pending") pendingTotalRef.current = data.count;
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
      await revokeAdminBoardInviteLink(row.id);
      // The nav count is the pending total; only a pending row was counted in it.
      if (row.status === "pending" && pendingTotalRef.current !== null) {
        pendingTotalRef.current = Math.max(0, pendingTotalRef.current - 1);
        onPendingCount?.(pendingTotalRef.current);
      }
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
        setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, status: "revoked", can_register: false } : r)));
      }
      setFocusHeading(true);
    } catch (err: unknown) {
      const httpStatus = (err as { response?: { status?: number } }).response?.status;
      if (httpStatus === 400 || httpStatus === 404) {
        // 400: redeemed; 404: already revoked (#1867). Redeemed or revoked elsewhere while the prompt was open: say so and
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
    <>
      <PageHeading
        level="h3"
        title="Board invites"
        description="Every board's invites, emailed and shareable. Revoke one that leaked."
        headingRef={headingRef}
      />

      {/* No per-status counts: the list is filtered on the server and only the selected status is loaded. */}
      <div role="group" aria-label="Status" className="flex flex-wrap items-center gap-2">
        {STATUS_OPTIONS.map((o) => (
          <FilterPill key={o.value} label={o.label} selected={statusFilter === o.value} onClick={() => handleFilterChange(o.value)} />
        ))}
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
        <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-danger/40 bg-danger/10 px-4 py-3">
          <p role="alert" className="text-sm text-danger-on-tint">Failed to load board invites.</p>
          <Button variant="secondary" onClick={() => { headingRef.current?.focus(); void fetchRows(statusFilter, offset); }}>Try again</Button>
        </div>
      ) : rows.length === 0 ? (
        <EmptyState title={emptyMessage} headingLevel="h3" />
      ) : (
        <>
          <ListWell>
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="text-fg-tertiary text-[13px] uppercase tracking-[0.06em]">
                  <th className="text-left px-3 py-2 font-semibold">Board</th>
                  <th className="text-left px-3 py-2 font-semibold">Role</th>
                  <th className="text-left px-3 py-2 font-semibold">Delivery</th>
                  <th className="text-left px-3 py-2 font-semibold">Status</th>
                  <th className="text-left px-3 py-2 font-semibold">Expires</th>
                  <th className="text-left px-3 py-2 font-semibold">Created by</th>
                  <th className="text-left px-3 py-2 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const pending = row.status === "pending";
                  const isConfirming = confirmId === row.id;
                  const inFlight = revokingId === row.id;
                  return (
                    <Fragment key={row.id}>
                      <tr className="hover:bg-surface transition-colors">
                        <td className="px-3 py-2 text-fg">
                          <div className="max-w-[14rem] truncate" title={row.board_name}>{row.board_name}</div>
                        </td>
                        <td className="px-3 py-2 text-fg-secondary">{INVITE_ROLE_LABELS[row.role] ?? row.role}</td>
                        <td className="px-3 py-2 text-fg-secondary">{row.delivery === "email" ? "Email" : "Link"}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className={row.status === "revoked" ? "line-through" : undefined}>
                              <StatusPill tone={statusTone(row.status)} label={capitalize(row.status)} />
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
                        <td className="px-3 py-2 text-fg-muted">{formatDate(row.expires_at)}</td>
                        <td className="px-3 py-2 text-fg-secondary">
                          {row.created_by_username ?? (
                            <span className="text-fg-secondary">Account removed</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {pending && !isConfirming && (
                            <Button
                              variant="quiet"
                              buttonRef={revokeTriggerRef(row.id)}
                              onClick={() => { setRevokeError(null); setConfirmId(row.id); }}
                              aria-label={`Revoke invite ${row.prefix} for ${row.board_name}`}
                            >
                              Revoke
                            </Button>
                          )}
                        </td>
                      </tr>
                      {isConfirming && (
                        <tr>
                          <td colSpan={7} className="px-3 pb-2">
                            <InlineConfirm
                              message={row.delivery === "email"
                                ? `Revoke this invite to ${row.board_name}? The person it was emailed to will no longer be able to join.`
                                : `Revoke this invite link to ${row.board_name}? Anyone holding it will no longer be able to join.`}
                              actionLabel="Revoke invite"
                              busy={inFlight}
                              onConfirm={() => void handleRevoke(row)}
                              onCancel={() => { if (inFlight) return; setConfirmId(null); setRevokeError(null); }}
                            />
                            {/* Failure slot only (#2232): the question is announced by useConfirmAnnouncement. */}
                            <p role="status" aria-live="polite" aria-atomic="true" className={revokeError?.id === row.id && revokeError.message === GENERIC_REVOKE_ERROR ? "mt-1 text-xs text-danger" : "sr-only"}>
                              {revokeError?.id === row.id && revokeError.message === GENERIC_REVOKE_ERROR ? revokeError.message : ""}
                            </p>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </ListWell>

          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-fg-secondary">
            <span>Showing {offset + 1}–{Math.min(offset + rows.length, total)} of {total}</span>
            {totalPages > 1 && (
              <div className="flex items-center gap-2">
                <Button variant="quiet" onClick={() => changeOffset(Math.max(0, offset - pageSize))} disabled={offset === 0}>Previous</Button>
                <Button variant="quiet" onClick={() => changeOffset(Math.min((totalPages - 1) * pageSize, offset + pageSize))} disabled={currentPage === totalPages}>Next</Button>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
