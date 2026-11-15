/**
 * Dispatched on a board cell by the column header's add-card button (#2270). The cell
 * opens its own new-card input, so its draft and focus return stay local to it.
 */
export const ADD_CARD_EVENT = "visiban:add-card";
