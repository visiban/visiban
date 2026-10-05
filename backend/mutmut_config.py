"""mutmut hooks for the backend-mutation pilot (#1384). Not imported by Django.

mutmut 2.x is single-process. The CI job splits one module across N parallel
jobs by giving each job a share of the source lines: job k of N mutates only
lines where ``line_index % N == k``. Every job has its own Postgres service
container, so the shards cannot collide on test data. Outside CI both variables
are unset and the hook skips nothing (one shard, all lines).
"""

import os

SHARDS = int(os.environ.get("MUTATION_SHARDS", "1"))
SHARD = int(os.environ.get("MUTATION_SHARD", "0"))


def pre_mutation(context):
    """Skip every mutant whose line does not belong to this shard."""
    if SHARDS > 1 and context.current_line_index % SHARDS != SHARD:
        context.skip = True
