"""Named OpenAPI components for the board-import responses (#1870).

Schema only: nothing here is used to serialize a response. The views build
plain dicts and these classes describe them so schema-generated clients get a
typed component instead of ``{type: object, additionalProperties: {}}``. The
payloads are documented exactly as they are today -- the JSON/CSV import returns
the board at the top level plus ``import_summary``, the Trello import wraps it
as ``{board, summary}`` -- and aligning the two envelopes (and adding
error ``code``s) is tracked in #1903. ``test_import_response_schemas_1870`` validates
live responses against these components so the declared shape cannot drift.
"""

from rest_framework import serializers

from .serializers import BoardSerializer


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


class ImportSummarySerializer(serializers.Serializer):
    """``import_summary`` on ``POST /boards/import/`` 201 responses."""

    options_applied = ImportOptionsAppliedSerializer()
    skipped = ImportSkippedCountsSerializer()
    warnings = serializers.ListField(
        child=serializers.CharField(), required=False,
        help_text="CSV import only: row-level warnings, capped with a trailing '...and N more' entry.",
    )


class BoardImportResponseSerializer(BoardSerializer):
    """The new board (same fields as ``GET /boards/{id}/``) plus ``import_summary``."""

    import_summary = ImportSummarySerializer()

    class Meta(BoardSerializer.Meta):
        fields = [*BoardSerializer.Meta.fields, "import_summary"]


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


class TrelloImportConfirmSerializer(serializers.Serializer):
    """``POST /boards/import/trello/?confirm=true`` 201 response."""

    board = BoardSerializer()
    summary = TrelloImportSummarySerializer()
