Creating or updating a board with a very large `staleness_threshold_days` no longer returns a 500. The field is now capped at 36500 days and a larger value returns a 400 on the field.
