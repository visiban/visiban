import type { ReactNode } from "react";
import type { Column, FlowBlocked, FlowCycleTime, FlowThroughput, FlowWipAge } from "../../../types";
import { PERCENTILE_APPEARS_AT, cardsPastP85, columnsOverLimit, formatNumber, pluralize } from "./flowFormat";

interface Props {
  cycle: FlowCycleTime | undefined;
  throughput: FlowThroughput | undefined;
  wipAge: FlowWipAge | undefined;
  blocked: FlowBlocked | undefined;
  columns: Pick<Column, "uid" | "wip_limit">[];
  /** A swimlane or label filter is on: a column's WIP limit counts every card, so the over-limit clause is left out. */
  filtered: boolean;
  /** Set once the first answers are in: a tile still without data failed. */
  settled?: boolean;
}

interface TileProps {
  label: string;
  /** Null: the value is withheld, and the sentence says why. */
  value: string | null;
  unit: string;
  provisional?: boolean;
  children: ReactNode;
}

function Tile({ label, value, unit, provisional = false, children }: TileProps) {
  return (
    <div className="bg-surface border border-line rounded-lg p-4 flex flex-col gap-1 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <h3 className="text-sm text-fg-tertiary">{label}</h3>
        {provisional && <span className="text-xs text-fg-tertiary border border-line-strong rounded px-1.5">Provisional</span>}
      </div>
      <p className="flex flex-wrap items-baseline gap-x-1 text-fg">
        {value === null ? (
          <span className="text-3xl font-semibold text-fg-tertiary">—<span className="sr-only">Withheld</span></span>
        ) : (
          <span className="text-3xl font-semibold">{value}</span>
        )}
        <span className="text-base text-fg-tertiary">{unit}</span>
      </p>
      <p className="text-xs text-fg-secondary">{children}</p>
    </div>
  );
}

function TilePlaceholder({ label, failed }: { label: string; failed: boolean }) {
  return (
    <div className="bg-surface border border-line rounded-lg p-4 flex flex-col gap-2 min-w-0">
      <h3 className="text-sm text-fg-tertiary">{label}</h3>
      {failed ? (
        <p className="text-xs text-fg-tertiary">Could not load.</p>
      ) : (
        <div aria-hidden="true" className="flex flex-col gap-2">
          <div className="h-8 w-16 rounded bg-surface-hover animate-pulse motion-reduce:animate-none" />
          <div className="h-8 rounded bg-surface-hover animate-pulse motion-reduce:animate-none" />
        </div>
      )}
    </div>
  );
}

const days = (n: number) => (n === 1 ? "day" : "days");

function CycleTile({ cycle }: { cycle: FlowCycleTime }) {
  const { p50, p85 } = cycle.percentiles;
  const n = cycle.sample_size;
  if (p50 === null) {
    return (
      <Tile label="Cycle time" value={null} unit="days" provisional>
        Median appears at {PERCENTILE_APPEARS_AT.p50}. {n} so far.
      </Tile>
    );
  }
  return (
    <Tile label="Cycle time" value={formatNumber(p50)} unit={days(p50)} provisional={p85 === null}>
      {p85 === null
        ? `Median of ${pluralize(n, "card")}. The 85% figure appears at ${PERCENTILE_APPEARS_AT.p85}.`
        : `Half finish within this. 85% within ${formatNumber(p85)} ${days(p85)}. Based on ${pluralize(n, "card")}.`}
    </Tile>
  );
}

function ThroughputTile({ throughput }: { throughput: FlowThroughput }) {
  const weeks = throughput.samples.length;
  return throughput.median === null ? (
    <Tile label="Throughput" value={String(throughput.total)} unit="cards so far" provisional>
      Too few whole weeks for a weekly median. {weeks} so far.
    </Tile>
  ) : (
    <Tile label="Throughput" value={formatNumber(throughput.median)} unit="/ week">
      Median of {pluralize(weeks, "week")}. {pluralize(throughput.total, "card")} finished.
    </Tile>
  );
}

function WipTile({ wipAge, columns, filtered }: { wipAge: FlowWipAge; columns: Props["columns"]; filtered: boolean }) {
  const over = filtered ? null : columnsOverLimit(wipAge, columns);
  const p85 = wipAge.cycle_time_percentiles.p85;
  const past = p85 === null ? null : cardsPastP85(wipAge);
  return (
    <Tile label="Work in progress" value={String(wipAge.sample_size)} unit={wipAge.sample_size === 1 ? "card" : "cards"}>
      {over !== null && (
        <span className={over > 0 ? "text-warning" : undefined}>
          {pluralize(over, "column")} over {over === 1 ? "its" : "their"} limit.{" "}
        </span>
      )}
      {past !== null && p85 !== null && (
        <span className={past > 0 ? "text-warning" : undefined}>
          {pluralize(past, "card")} past {formatNumber(p85)} {days(p85)}.
        </span>
      )}
      {over === null && past === null && "Cards in progress now."}
    </Tile>
  );
}

function BlockedTile({ blocked }: { blocked: FlowBlocked }) {
  const total = blocked.total.days;
  return (
    <Tile label="Blocked time" value={formatNumber(total)} unit={days(total)}>
      {pluralize(blocked.total.blocks, "block")}. {pluralize(blocked.blocked_now, "card")} blocked right now.
    </Tile>
  );
}

/**
 * Region 5, right (#2261): four headline numbers. The server's nulls decide
 * what is withheld (ADR #1532); the tiles only say so, and when a value appears.
 */
export default function HeadlineTiles({ cycle, throughput, wipAge, blocked, columns, filtered, settled = false }: Props) {
  return (
    <section aria-labelledby="analytics-tiles-heading" className="grid grid-cols-2 lg:grid-cols-4 gap-4 min-w-0" data-testid="analytics-tiles">
      {/* The tiles' own h2, so their h3s do not nest under the bottleneck's heading. */}
      <h2 id="analytics-tiles-heading" className="sr-only">Headline numbers</h2>
      {cycle ? <CycleTile cycle={cycle} /> : <TilePlaceholder label="Cycle time" failed={settled} />}
      {throughput ? <ThroughputTile throughput={throughput} /> : <TilePlaceholder label="Throughput" failed={settled} />}
      {wipAge ? <WipTile wipAge={wipAge} columns={columns} filtered={filtered} /> : <TilePlaceholder label="Work in progress" failed={settled} />}
      {blocked ? <BlockedTile blocked={blocked} /> : <TilePlaceholder label="Blocked time" failed={settled} />}
    </section>
  );
}
