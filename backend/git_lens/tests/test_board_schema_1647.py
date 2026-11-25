"""GET /git-lens/board/{board_id}/ publishes a typed 200 (#1647).

The view serves ``LensData.to_dict()``, hand-built from the dataclasses in
``git_lens/types.py``, so before #1647 the published 200 was ``{}`` and the
lens schema-fuzz job's response conformance check (#1338) and the
serializer-ts-parity gate had nothing to compare the body against.

The declared serializers are schema-only (the view never runs them), so they
can drift from the dataclasses silently. ``LensDataSchemaMirrorTests`` pins
them together: same keys at every level, and ``allow_null`` on exactly the
dataclass fields typed ``X | None``.
"""
import pytest
from django.conf import settings

if not settings.GIT_LENS_ENABLED:  # pragma: no cover - exercised only in the flagged CI job
    pytest.skip(
        "git_lens experiment disabled; set GIT_LENS_ENABLED=true to run these.",
        allow_module_level=True,
    )

import contextlib
import dataclasses
import io

from django.test import SimpleTestCase
from drf_spectacular.generators import SchemaGenerator
from rest_framework import serializers

from git_lens.serializers import (
    LensAxisSerializer,
    LensDataSerializer,
    LensLabelSerializer,
    LensPipelineEvidenceSerializer,
    LensUserSerializer,
    NormalizedIssueSerializer,
)
from git_lens.types import (
    LensAxis,
    LensData,
    LensLabel,
    LensUser,
    NormalizedIssue,
    PipelineEvidence,
)

_PATH = "/api/v1/git-lens/board/{board_id}/"


def _full_lens_data():
    """A LensData with every optional branch populated, so to_dict() emits every key."""
    return LensData(
        columns=[LensAxis("open", "Open")],
        swimlanes=[LensAxis("v1", "v1", is_current=True)],
        issues=[
            NormalizedIssue(
                number=1, title="t", url="u", state="open",
                labels=[LensLabel("bug", "ff0000")],
                assignees=[LensUser("ann", "https://a.example/ann.png")],
                milestone="v1", milestone_due="2026-12-31", milestone_state="active",
                column_keys=["open"], swimlane_keys=["v1"],
                has_branch=True, has_open_pr=True,
                pipeline_evidence=PipelineEvidence(
                    branch="1-fix", mr_number=2, mr_url="https://g.example/mr/2", mr_closes=True,
                ),
            )
        ],
        fetched_at="2026-06-06T00:00:00+00:00",
        source_provider="gitlab",
        source_repo="g/p",
        source_url="https://gitlab.com/g/p",
        total_count=1,
        closed_limit=20,
        available_milestones=["v1"],
    )


class LensBoardResponseSchemaTests(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with contextlib.redirect_stderr(io.StringIO()):
            cls.schema = SchemaGenerator().get_schema(request=None, public=True)
        cls.components = cls.schema["components"]["schemas"]

    def test_200_references_the_lens_data_component(self):
        # Before #1647 this response had no content at all.
        ok = self.schema["paths"][_PATH]["get"]["responses"]["200"]
        self.assertEqual(
            ok["content"]["application/json"]["schema"],
            {"$ref": "#/components/schemas/LensData"},
        )

    def test_every_lens_data_key_is_required(self):
        # to_dict() always emits every key, so none may be published as optional.
        component = self.components["LensData"]
        self.assertEqual(sorted(component["required"]), sorted(_full_lens_data().to_dict()))

    def test_nullable_fields_are_published_nullable(self):
        data = self.components["LensData"]["properties"]
        for name in ("total_count", "closed_limit"):
            with self.subTest(field=name):
                self.assertTrue(data[name].get("nullable"), name)
        self.assertFalse(data["truncated"].get("nullable", False))
        issue = self.components["NormalizedIssue"]["properties"]
        for name in ("milestone", "milestone_due", "milestone_state", "pipeline_evidence"):
            with self.subTest(field=name):
                # A nullable nested serializer is published as oneOf/allOf + nullable.
                self.assertTrue(issue[name].get("nullable"), name)
        evidence = self.components["LensPipelineEvidence"]["properties"]
        for name in ("branch", "mr_number", "mr_url"):
            with self.subTest(field=name):
                self.assertTrue(evidence[name].get("nullable"), name)
        self.assertFalse(evidence["mr_closes"].get("nullable", False))

    def test_no_enum_component_was_renamed(self):
        # A ChoiceField named ``state`` or ``provider`` here collided with the
        # existing enum components and made drf-spectacular rename them
        # (StateEnum -> ChildrenViewChildStateEnum), a break for generated
        # clients. Those two fields are published as plain strings instead.
        self.assertIn("StateEnum", self.components)
        self.assertIn("LensConnectionProviderEnum", self.components)


class LensDataSchemaMirrorTests(SimpleTestCase):
    """The schema-only serializers mirror the dataclasses the view serves."""

    PAIRS = (
        (LensAxisSerializer, LensAxis),
        (LensLabelSerializer, LensLabel),
        (LensUserSerializer, LensUser),
        (LensPipelineEvidenceSerializer, PipelineEvidence),
        (NormalizedIssueSerializer, NormalizedIssue),
    )

    def test_field_names_match_the_dataclasses(self):
        for serializer_cls, dc in self.PAIRS:
            with self.subTest(serializer=serializer_cls.__name__):
                self.assertEqual(
                    set(serializer_cls().fields),
                    {f.name for f in dataclasses.fields(dc)},
                )

    def test_allow_null_matches_optional_dataclass_fields(self):
        # types.py uses ``from __future__ import annotations``: f.type is a string.
        for serializer_cls, dc in self.PAIRS:
            fields = serializer_cls().fields
            for f in dataclasses.fields(dc):
                with self.subTest(serializer=serializer_cls.__name__, field=f.name):
                    self.assertEqual(fields[f.name].allow_null, "None" in str(f.type))

    def test_lens_data_keys_match_to_dict(self):
        payload = _full_lens_data().to_dict()
        self.assertEqual(set(LensDataSerializer().fields), set(payload))
        self.assertEqual(set(LensDataSerializer().fields["source"].fields), set(payload["source"]))

    def test_a_real_payload_validates_against_the_serializer(self):
        # The body the view actually sends is accepted field for field, nulls
        # included, so the published types are the served types.
        for payload in (_full_lens_data().to_dict(), _bare_payload()):
            with self.subTest(full=payload["total_count"] is not None):
                s = LensDataSerializer(data=payload)
                self.assertTrue(s.is_valid(), s.errors)

    def test_nested_list_fields_are_serializers(self):
        # Guards against a future edit flattening a nested list to a plain field.
        self.assertIsInstance(LensDataSerializer().fields["issues"], serializers.ListSerializer)


def _bare_payload():
    """Every optional field left at its default (None/empty), as a sparse board sends."""
    return LensData(
        columns=[], swimlanes=[],
        issues=[NormalizedIssue(number=1, title="", url="", state="closed")],
        fetched_at="2026-06-06T00:00:00+00:00",
        source_provider="github", source_repo="o/r", source_url="https://github.com/o/r",
    ).to_dict()
