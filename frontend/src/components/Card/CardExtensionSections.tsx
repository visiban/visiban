import { useEffect, useId, useState } from "react";
import { getCardExtensions } from "../../api/cards";
import type { CardExtensionField, CardExtensionSection } from "../../types";
import { formatDateStr } from "../../utils/date";
import { parseCardExtensionSections } from "./parseCardExtensionSections";

interface Props {
  boardId: number;
  cardId: number;
  userDateFormat?: string;
}

function readValue(field: CardExtensionField, userDateFormat: string): string | null {
  if (field.display) return field.display;
  if (field.value === null || field.value === "") return null;
  if (field.type === "date" && typeof field.value === "string") return formatDateStr(field.value, userDateFormat);
  return String(field.value);
}

function ExtensionSection({ section, userDateFormat }: { section: CardExtensionSection; userDateFormat: string }) {
  const headingId = useId();
  return (
    <>
      <section role="region" aria-labelledby={headingId} data-testid="card-extension-section" className="flex flex-col gap-2">
        <h3 id={headingId} className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{section.title}</h3>
        <dl className="flex flex-col gap-2">
          {section.fields.map((field) => {
            const shown = readValue(field, userDateFormat);
            return (
              <div key={field.key} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-3 max-sm:grid-cols-1 max-sm:gap-y-0.5">
                <dt className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{field.label}</dt>
                <dd className={`text-sm whitespace-pre-wrap break-words ${shown === null ? "text-fg-muted" : "text-fg-secondary"}`}>
                  {shown ?? "Not set"}
                </dd>
              </div>
            );
          })}
        </dl>
      </section>
      <div className="border-t border-line" />
    </>
  );
}

/**
 * Card-detail extension sections (#2212, experimental): read-only records an in-process extension
 * attaches to a card, rendered in the Details tab after Weight. Plain text only, no colors of its own.
 * While loading, after a failed fetch, and when there are no sections, NOTHING renders: no heading,
 * placeholder, skeleton or reserved space, so with no extension registered the tab is unchanged.
 */
export default function CardExtensionSections({ boardId, cardId, userDateFormat = "MM/DD/YYYY" }: Props) {
  const [sections, setSections] = useState<CardExtensionSection[]>([]);

  useEffect(() => {
    let live = true;
    setSections([]);
    getCardExtensions(boardId, cardId)
      .then((payload) => { if (live) setSections(parseCardExtensionSections(payload)); })
      .catch(() => {
        // No payload or error text: it may carry extension content.
        if (live) console.warn("Card extension sections: fetch failed; nothing rendered.");
      });
    return () => { live = false; };
  }, [boardId, cardId]);

  if (sections.length === 0) return null;
  return (
    <>
      {sections.map((s) => <ExtensionSection key={s.id} section={s} userDateFormat={userDateFormat} />)}
    </>
  );
}
