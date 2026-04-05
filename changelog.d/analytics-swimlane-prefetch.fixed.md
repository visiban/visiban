Fix analytics endpoint issuing a live swimlane query on every request — swimlanes are now loaded into a list before the loop, consistent with how columns and the summary endpoint already handle it.
