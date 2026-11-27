"""Named OpenAPI components for the board-import responses (#1870).

Schema only: nothing here is used to serialize a response. The views build
plain dicts and these classes describe them so schema-generated clients get a
typed component instead of ``{type: object, additionalProperties: {}}``.

Since #1903 both imports return the same envelope: the board's fields at the
top level and under ``board``, the summary under ``import_summary`` and
``summary`` (each is a key one of the two endpoints already had, so nothing
was removed). The summary's contents still differ by source. Error bodies are
``{detail, code}`` (``ImportErrorSerializer``). ``test_import_response_schemas_1870``
and ``test_import_envelope_1903`` validate live responses against these
components so the declared shape cannot drift.
"""

from rest_framework import serializers

from .import_errors import ImportErrorCode
from .serializers import BoardSerializer


class ImportErrorSerializer(serializers.Serializer):
    """Every 4xx body from ``POST /boards/import/`` and ``POST /boards/import/trello/`` (#1903)."""

    detail = serializers.CharField(help_text="Human-readable message. May be reworded; do not match on it.")
    code = serializers.CharField(help_text=(
        "Stable machine-readable code; branch on this, not on detail. Import codes: "
        + ", ".join(ImportErrorCode.ALL)
        + ". Errors raised outside the importer carry DRF's code for the exception "
        "(not_authenticated, permission_denied, not_found, throttled, parse_error, ...). "
        "New codes may be added; treat an unknown one like invalid_import."
    ))


class ImportOptionsAppliedSerializer(serializers.Serializer):
    """The options a Visiban JSON/CSV import resolved and applied."""

    labels = serializers.BooleanField()
    cards = serializers.BooleanField()
    comments = serializers.BooleanField()
    checklist = serializers.BooleanField()
    history = serializers.BooleanField()
    shift_dates_from = serializers.DateField(
        required=False, help_text=(
            "YYYY-MM-DD; present when it was sent, or when the file's date_anchor "
            "was applied in its place (JSON import only)."
        ),
    )
    shift_dates = serializers.BooleanField(
        required=False, help_text="Present only when it was sent (JSON import only).",
    )
    shift_dates_to = serializers.DateField(
        required=False, help_text=(
            "YYYY-MM-DD; present only when it was sent and the import shifted dates (JSON import only)."
        ),
    )


class ImportSkippedCountsSerializer(serializers.Serializer):
    """Items in the file that the chosen options left out."""

    cards = serializers.IntegerField()
    comments = serializers.IntegerField()
    checklist_items = serializers.IntegerField()
    label_refs = serializers.IntegerField()
    movements = serializers.IntegerField()
    activities = serializers.IntegerField()
    colors = serializers.IntegerField(help_text="Colors replaced with the default because they were not hex (#2093).")
    assignees = serializers.IntegerField(help_text=(
        "Card and checklist item assignee names that matched no user the importer can see, "
        "so the card or item was imported unassigned (#2198)."
    ))
    blocks = serializers.IntegerField(help_text=(
        "Block history rows (live and deleted cards) the import would have written with `history` on (#2413)."
    ))
    gate_transitions = serializers.IntegerField(help_text=(
        "Gate history rows (live and deleted cards) the import would have written with `history` on (#2413)."
    ))
    relations = serializers.IntegerField(help_text=(
        "Card relations the import would have written with `cards` on (#1448)."
    ))


class ImportSummarySerializer(serializers.Serializer):
    """``import_summary`` on ``POST /boards/import/`` 201 responses."""

    options_applied = ImportOptionsAppliedSerializer()
    skipped = ImportSkippedCountsSerializer()
    warnings = serializers.ListField(
        child=serializers.CharField(), required=False,
        help_text=(
            "Row-level warnings, capped with a trailing '...and N more' entry. CSV imports always "
            "carry the list; a JSON import carries it only when something was skipped, "
            "e.g. an entry requirement naming a field or field set the file does not define (#1923)."
        ),
    )


class BoardImportResponseSerializer(BoardSerializer):
    """The new board (same fields as ``GET /boards/{id}/``) plus ``import_summary``.

    ``board`` and ``summary`` (#1903) repeat the same board and summary in the
    Trello import's envelope.
    """

    import_summary = ImportSummarySerializer()
    board = BoardSerializer(help_text="Since 1.3: the same board as the top-level fields.")
    summary = ImportSummarySerializer(help_text="Since 1.3: the same object as import_summary.")

    class Meta(BoardSerializer.Meta):
        fields = [*BoardSerializer.Meta.fields, "import_summary", "board", "summary"]


class TrelloImportCountsSerializer(serializers.Serializer):
    lists = serializers.IntegerField()
    lists_archived = serializers.IntegerField()
    cards = serializers.IntegerField()
    cards_archived = serializers.IntegerField()
    labels = serializers.IntegerField()
    checklists = serializers.IntegerField()
    checklist_items = serializers.IntegerField()
    comments = serializers.IntegerField()
    attachments = serializers.IntegerField()
    members = serializers.IntegerField()


class TrelloImportResultCountsSerializer(serializers.Serializer):
    columns = serializers.IntegerField()
    swimlanes = serializers.IntegerField()
    labels = serializers.IntegerField()
    cards = serializers.IntegerField()
    cards_archived = serializers.IntegerField()
    checklist_items = serializers.IntegerField()
    comments = serializers.IntegerField()


class TrelloImportWarningSerializer(serializers.Serializer):
    code = serializers.CharField()
    message = serializers.CharField()
    count = serializers.IntegerField()


class TrelloImportUnmappableSerializer(serializers.Serializer):
    kind = serializers.CharField()
    count = serializers.IntegerField()


class TrelloImportBoardInfoSerializer(serializers.Serializer):
    name = serializers.CharField()
    description = serializers.CharField()


class TrelloMappedColumnSerializer(serializers.Serializer):
    trello_id = serializers.CharField()
    name = serializers.CharField()
    position = serializers.IntegerField(allow_null=True)
    card_count = serializers.IntegerField()
    archived = serializers.BooleanField()


class TrelloMappedLabelSerializer(serializers.Serializer):
    trello_id = serializers.CharField()
    name = serializers.CharField()
    color = serializers.CharField()
    original_color = serializers.CharField(allow_null=True)
    card_count = serializers.IntegerField()
    swimlane_eligible = serializers.BooleanField()


class TrelloMappedSwimlaneSerializer(serializers.Serializer):
    name = serializers.CharField()
    label_id = serializers.CharField(allow_null=True)


class TrelloImportMappingPreviewSerializer(serializers.Serializer):
    columns = TrelloMappedColumnSerializer(many=True)
    labels = TrelloMappedLabelSerializer(many=True)
    swimlanes = TrelloMappedSwimlaneSerializer(many=True)
    default_swimlane = serializers.CharField()


class TrelloUnmatchedMemberSerializer(serializers.Serializer):
    trello_id = serializers.CharField()
    full_name = serializers.CharField()


class TrelloImportMembersSerializer(serializers.Serializer):
    total = serializers.IntegerField()
    matched = serializers.IntegerField(help_text="A count only; which accounts matched is never returned.")
    unmatched = TrelloUnmatchedMemberSerializer(many=True)


class TrelloImportOptionsSerializer(serializers.Serializer):
    swimlane_label_ids = serializers.ListField(child=serializers.CharField())
    default_swimlane_name = serializers.CharField()
    include_archived_lists = serializers.BooleanField()
    add_matched_members = serializers.BooleanField()


class TrelloImportPreviewSerializer(serializers.Serializer):
    """``POST /boards/import/trello/?dry_run=true`` 200 response."""

    source = serializers.CharField()
    file_sha256 = serializers.CharField()
    board = TrelloImportBoardInfoSerializer()
    counts = TrelloImportCountsSerializer()
    result = TrelloImportResultCountsSerializer()
    mapping = TrelloImportMappingPreviewSerializer()
    members = TrelloImportMembersSerializer()
    options = TrelloImportOptionsSerializer()
    warnings = TrelloImportWarningSerializer(many=True)
    unmappable = TrelloImportUnmappableSerializer(many=True)


class TrelloImportSummarySerializer(serializers.Serializer):
    counts = TrelloImportCountsSerializer()
    result = TrelloImportResultCountsSerializer()
    warnings = TrelloImportWarningSerializer(many=True)
    unmappable = TrelloImportUnmappableSerializer(many=True)


class TrelloImportConfirmSerializer(BoardSerializer):
    """``POST /boards/import/trello/?confirm=true`` 201 response.

    ``{board, summary}``, plus (#1903) the board's fields at the top level and
    the summary again as ``import_summary``, the JSON/CSV import's envelope.
    """

    board = BoardSerializer()
    summary = TrelloImportSummarySerializer()
    import_summary = TrelloImportSummarySerializer(help_text="Since 1.3: the same object as summary.")

    class Meta(BoardSerializer.Meta):
        fields = [*BoardSerializer.Meta.fields, "board", "summary", "import_summary"]
