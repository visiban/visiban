/** Why a custom field's type is locked, and the way out (#2194). One string per
 * resource noun, shared by the card and swimlane field editors so they say the
 * same thing. Custom-field values are not recorded in history in OSS (#1909),
 * so "can't be recovered" is the whole truth about a delete. */
export function typeLockedMessage(noun: "cards" | "swimlanes"): string {
  return `The type can't be changed because ${noun} already have values for this field. To use a different type, add a new field of that type, then delete this one. Deleting a field permanently deletes all of its values, and they can't be recovered.`;
}
