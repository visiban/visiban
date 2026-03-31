---
Fixed label and checklist items not appearing in card history on imported boards. Both JSON and CSV import paths now emit `LABEL_CHANGE` and `CHECKLIST_ITEM_ADDED` activity records, consistent with the live card update path.
