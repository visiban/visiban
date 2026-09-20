"""Regression tests for UserSerializer.email schema/validation (backend-schema-fuzz).

A PATCH to `/api/v1/auth/user/` writing a blank email (a legitimate value —
`User.email` is `blank=True`, e.g. accounts provisioned via SSO without an
email claim) made every subsequent read of that user fail OpenAPI schema
conformance, because `serializers.EmailField` unconditionally declares
`format: email` regardless of `allow_blank`. See EmailOrBlankField in
accounts/serializers.py.
"""

from django.test import TestCase

from accounts.serializers import UserSerializer


class UserSerializerEmailTests(TestCase):
    def test_blank_email_is_valid(self):
        serializer = UserSerializer(data={"email": ""}, partial=True)
        self.assertTrue(serializer.is_valid(), serializer.errors)

    def test_well_formed_email_is_valid(self):
        serializer = UserSerializer(data={"email": "person@example.com"}, partial=True)
        self.assertTrue(serializer.is_valid(), serializer.errors)

    def test_malformed_email_is_rejected(self):
        serializer = UserSerializer(data={"email": "not-an-email"}, partial=True)
        self.assertFalse(serializer.is_valid())
        self.assertIn("email", serializer.errors)

    def test_schema_drops_format_email_for_blank_compatibility(self):
        from drf_spectacular.openapi import AutoSchema

        field = UserSerializer().fields["email"]
        schema = AutoSchema()._map_serializer_field(field, "response")
        AutoSchema()._insert_field_validators(field, schema)
        self.assertNotIn("format", schema)
