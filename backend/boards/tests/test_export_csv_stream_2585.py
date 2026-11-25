"""#2585: the CSV export is streamed a chunk of cards at a time.

The bytes must be what the buffered export sent, the audit row must exist as
soon as any data can leave, and under ASGI (daphne in production) the body
must still be pulled chunk by chunk and must never end cleanly after a failure.
"""
import asyncio
import csv
import io
from unittest import mock

from asgiref.sync import async_to_sync
from django.core.cache import cache
from django.http import StreamingHttpResponse
from django.test import AsyncClient

from boards.models import BoardExportLog
from boards.tests.test_export_relations_history_2413 import _Fixture
from boards.views import import_export as ie


def _buffered(rows):
    """What the pre-#2585 export did with the same rows: one writer, one buffer."""
    buf = io.StringIO()
    csv.writer(buf).writerows(rows)
    return buf.getvalue().encode("utf-8")


class CsvStreamTests(_Fixture):
    def setUp(self):
        super().setUp()
        self.build_rich_board()
        # Everything the writer has to quote, plus non-ASCII.
        self._card('Comma, "quote"\nnewline é', self.doing, self.lane_b, 2, description="a\r\nb")
        self.url = f"/api/v1/boards/{self.board.pk}/export/"

    def _get(self):
        cache.clear()
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 200)
        return response

    def test_streamed_bytes_equal_the_single_buffer_output(self):
        for size in (1, 2, 4, 500):
            with self.subTest(size), mock.patch.object(ie, "_EXPORT_CHUNK_SIZE", size):
                response = self._get()
                self.assertIsInstance(response, StreamingHttpResponse)
                self.assertEqual(response["Content-Type"], "text/csv")
                self.assertFalse(response.has_header("Content-Length"))
                body = response.getvalue()
                rows = list(csv.reader(io.StringIO(body.decode("utf-8"), newline="")))
                self.assertEqual(len(rows), 6)  # header and five cards
                # Re-writing the parsed rows with one writer reproduces the
                # bytes: same header, CRLF terminators and quoting.
                self.assertEqual(body, _buffered(rows))
                self.assertTrue(body.startswith(b"Card ID,Title,Description,"))
                self.assertTrue(body.endswith(b"\r\n"))

    def test_chunk_helper_matches_a_single_buffer_at_every_boundary(self):
        header = ["a", "b"]
        rows = [[i, 'x,"y"\n'] for i in range(4)]
        for size in (1, 2, 3, 4, 5):
            with self.subTest(size), mock.patch.object(ie, "_EXPORT_CHUNK_SIZE", size):
                emitted = [0]
                chunks = list(ie._csv_export_chunks(header, iter(rows), emitted))
                self.assertEqual("".join(chunks).encode(), _buffered([header, *rows]))
                self.assertEqual(emitted, [4])
                # No chunk holds more than a chunk of rows (plus the header).
                self.assertTrue(all(len(list(csv.reader(io.StringIO(c)))) <= size + 1 for c in chunks))
        self.assertEqual(list(ie._csv_export_chunks(header, [], [0])), ["a,b\r\n"])

    def test_rows_are_built_as_the_body_is_read(self):
        built = []
        original = ie._iter_export_cards

        def counting(queryset):
            for card in original(queryset):
                built.append(card.pk)
                yield card

        with mock.patch.object(ie, "_EXPORT_CHUNK_SIZE", 1), mock.patch.object(ie, "_iter_export_cards", counting):
            response = self._get()
            self.assertEqual(len(built), 1)
            response.getvalue()
        self.assertEqual(len(built), 5)

    def test_audit_row_exists_before_the_body_is_read(self):
        with mock.patch.object(ie, "_EXPORT_CHUNK_SIZE", 1):
            response = self._get()
            log = BoardExportLog.objects.get()
            self.assertEqual((log.export_format, log.row_count), ("csv", 5))
            response.getvalue()
        log.refresh_from_db()
        self.assertEqual(log.row_count, 5)

    def test_audit_row_ends_with_the_rows_actually_sent(self):
        with mock.patch.object(ie, "_EXPORT_CHUNK_SIZE", 1):
            response = self._get()
            self.board.cards.filter(title="Gamma").delete()
            response.getvalue()
        self.assertEqual(BoardExportLog.objects.get().row_count, 4)

    def test_failure_in_the_first_chunk_raises_and_logs_no_export(self):
        with mock.patch.object(ie, "_iter_export_cards", side_effect=RuntimeError("db gone")):
            with self.assertRaises(RuntimeError):
                self.client.get(self.url)
        self.assertEqual(BoardExportLog.objects.count(), 0)


class CsvStreamAsgiTests(_Fixture):
    def setUp(self):
        super().setUp()
        self.build_rich_board()
        self.url = f"/api/v1/boards/{self.board.pk}/export/"
        self.async_client = AsyncClient()
        self.async_client.force_login(self.owner)

    def _read(self):
        async def read():
            response = await self.async_client.get(self.url)
            self.assertEqual(response.status_code, 200)
            self.assertTrue(response.is_async)
            parts = []
            try:
                async for part in response.streaming_content:
                    parts.append(part)
            except asyncio.CancelledError:
                return parts, True
            return parts, False

        cache.clear()
        return async_to_sync(read)()

    def test_asgi_response_is_pulled_a_chunk_at_a_time(self):
        expected = self.client.get(self.url).getvalue()
        with mock.patch.object(ie, "_EXPORT_CHUNK_SIZE", 1):
            parts, cancelled = self._read()
        self.assertFalse(cancelled)
        self.assertEqual(len(parts), 4)  # four cards, the header on the first
        self.assertEqual(b"".join(parts), expected)

    def test_failure_after_the_first_chunk_cancels_instead_of_finishing(self):
        original = ie._iter_export_cards

        def failing(queryset):
            yield next(iter(original(queryset)))
            raise RuntimeError("db gone")

        with mock.patch.object(ie, "_EXPORT_CHUNK_SIZE", 1), mock.patch.object(ie, "_iter_export_cards", failing):
            with self.assertLogs(ie.logger, "ERROR") as logs:
                parts, cancelled = self._read()
        self.assertTrue(cancelled, "a truncated file must not end normally")
        self.assertEqual(len(parts), 1)
        self.assertIn(f"board {self.board.pk}", logs.output[0])
        # The data that left is still on record.
        self.assertEqual(BoardExportLog.objects.get().row_count, 4)
