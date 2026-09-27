`allowed_priorities` on boards now rejects falsy non-list values (`false`, `0`, `""`, `{}`) with a 400 instead of storing them and returning a payload that violates the documented array schema.
