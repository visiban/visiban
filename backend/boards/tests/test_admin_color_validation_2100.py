"""#2100 - the Django admin forms apply the same hex rule as the API (#2093)."""
from django.contrib import admin
from django.test import RequestFactory, TestCase

from accounts.models import User
from boards.models import Board, Column, Label, Swimlane
from groups.models import Group


class AdminColorFormTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = User.objects.create_superuser(username="a2100", password="p", email="a2100@x")
        group = Group.objects.create(name="G2100", owner=cls.user)
        cls.board = Board.objects.create(name="B2100", owner=cls.user, group=group)

    def _form_class(self, model):
        request = RequestFactory().get("/")
        request.user = self.user
        return admin.site._registry[model].get_form(request)

    def _data(self, model, instance, color):
        """Bound data: the instance's own values, with ``color`` replaced."""
        form = self._form_class(model)(instance=instance)
        data = {}
        for name, field in form.fields.items():
            value = form.initial.get(name)
            if value is None:
                continue
            if hasattr(value, "pk"):
                value = value.pk
            elif isinstance(value, (list, dict)):
                continue
            data[name] = value
        data["color"] = color
        return form.__class__, data

    def _make(self, model, color):
        self._n = getattr(self, "_n", 0) + 1
        n = f"x{self._n}"
        if model is Column:
            return Column.objects.create(board=self.board, name=n, position=self._n, color=color)
        if model is Swimlane:
            return Swimlane.objects.create(board=self.board, name=n, position=self._n, color=color)
        return Label.objects.create(board=self.board, name=n, color=color)

    def _form(self, model, instance, color):
        cls, data = self._data(model, instance, color)
        return cls(data=data, instance=instance)

    def test_valid_hex_accepted_and_short_form_expanded(self):
        for model in (Column, Swimlane, Label):
            with self.subTest(model=model.__name__):
                obj = self._make(model, "#112233")
                form = self._form(model, obj, "#abc")
                self.assertTrue(form.is_valid(), form.errors)
                self.assertEqual(form.cleaned_data["color"], "#aabbcc")
                form = self._form(model, obj, "#A1B2C3")
                self.assertTrue(form.is_valid(), form.errors)
                self.assertEqual(form.cleaned_data["color"], "#A1B2C3")

    def test_invalid_color_rejected_with_field_error(self):
        for model in (Column, Swimlane, Label):
            for bad in ("red", "#12345", "#ggg", "abcdef"):
                with self.subTest(model=model.__name__, bad=bad):
                    obj = self._make(model, "#112233")
                    form = self._form(model, obj, bad)
                    self.assertFalse(form.is_valid())
                    self.assertIn("color", form.errors)
                    self.assertEqual(form.errors["color"], ["Enter a color as #RRGGBB or #RGB."])

    def test_unchanged_legacy_value_still_saves(self):
        for model in (Column, Swimlane, Label):
            with self.subTest(model=model.__name__):
                obj = self._make(model, "red")
                form = self._form(model, obj, "red")
                self.assertTrue(form.is_valid(), form.errors)
                self.assertEqual(form.cleaned_data["color"], "red")

    def test_changing_legacy_value_to_non_hex_rejected(self):
        for model in (Column, Swimlane, Label):
            with self.subTest(model=model.__name__):
                obj = self._make(model, "red")
                form = self._form(model, obj, "blue")
                self.assertFalse(form.is_valid())
                self.assertIn("color", form.errors)

    def test_add_form_rejects_non_hex(self):
        form_cls = self._form_class(Label)
        form = form_cls(data={"board": self.board.pk, "name": "n", "color": "red"})
        self.assertFalse(form.is_valid())
        self.assertIn("color", form.errors)

    def test_non_ascii_digits_rejected(self):
        obj = self._make(Label, "#112233")
        form = self._form(Label, obj, "#٠٠٠")
        self.assertFalse(form.is_valid())
        self.assertIn("color", form.errors)
