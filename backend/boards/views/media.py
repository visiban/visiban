"""ServeMediaView — authenticated media serving with board-membership checks."""

from django.conf import settings as django_settings
from django.http import HttpResponse
from rest_framework.permissions import IsAuthenticated
from rest_framework.views import APIView

from visiban.permissions import (
    MustNotHavePendingPasswordChange,
    MustNotHavePendingUsernameChange,
)
from ..models import CardAttachment
from ..permissions import get_board_role


class ServeMediaView(APIView):
    """Serve uploaded attachment files with authentication and board-membership checks.

    In production, Django authenticates the request and confirms board membership,
    then delegates the actual file transfer to Nginx via X-Accel-Redirect (zero
    Python I/O overhead). In development (DEBUG=True), Django serves the file
    directly so the stack works without Nginx.

    This replaces the unauthenticated /media/ Nginx proxy — see nginx/app.conf.template.
    Any request that reaches this view but cannot be matched to a known attachment
    (deleted, never existed, or path tampered) receives 404, not 403, to avoid
    leaking whether a path is a valid attachment.
    """

    permission_classes = [
        IsAuthenticated,
        MustNotHavePendingPasswordChange,
        MustNotHavePendingUsernameChange,
    ]

    def get(self, request, path):
        try:
            attachment = (
                CardAttachment.objects
                .select_related("card__board")
                .get(file=path)
            )
        except CardAttachment.DoesNotExist:
            from django.http import Http404
            raise Http404

        board = attachment.card.board
        role = get_board_role(request.user, board)
        if not role:
            # Return 404 (not 403) to avoid leaking whether a file path is a
            # valid attachment — an attacker who knows a valid path should not
            # receive confirmation of that fact via a 403.
            from django.http import Http404
            raise Http404

        # Determine Content-Type from the stored filename (not the URL path,
        # which could be tampered) and set Content-Disposition to prevent
        # browsers from rendering uploaded files inline as HTML (#372).
        import mimetypes
        content_type, _ = mimetypes.guess_type(attachment.filename)
        content_type = content_type or "application/octet-stream"
        # Only allow inline display for known-safe image types; everything
        # else is forced to download to prevent stored XSS via polyglot files.
        _safe_inline_types = {"image/jpeg", "image/png", "image/gif", "image/webp"}
        if content_type in _safe_inline_types:
            disposition = "inline"
        else:
            # Sanitize before embedding in the header — a bare double-quote in the
            # filename triggers Django's BadHeaderError and returns HTTP 500 to every
            # subsequent download attempt for that attachment.  Strip path components
            # as an additional guard; the stored filename should already be clean after
            # the fix in cards.py but defense-in-depth covers existing rows.
            from django.utils.text import get_valid_filename
            import os
            # Defense-in-depth: re-sanitize on serve even though filenames are
            # sanitized at upload time. Covers attachments created before the
            # upload-time fix was deployed.
            safe_name = get_valid_filename(os.path.basename(attachment.filename))
            safe_name = safe_name.translate({ord("\r"): None, ord("\n"): None, ord("\x00"): None}) or "attachment"
            disposition = f'attachment; filename="{safe_name}"'

        if django_settings.DEBUG:
            # Development: serve the file directly through Django. Not used in
            # production where Nginx handles the transfer via X-Accel-Redirect.
            from django.http import FileResponse, Http404
            import os
            # Defense-in-depth: the CardAttachment lookup above already binds
            # `path` to a DB row so an attacker cannot request arbitrary files,
            # but resolve and verify the path is contained within MEDIA_ROOT
            # before opening so a future regression in upload sanitization
            # cannot escalate into a read primitive on the dev server.
            media_root = os.path.realpath(django_settings.MEDIA_ROOT)
            resolved = os.path.realpath(os.path.join(media_root, path))
            if os.path.commonpath([media_root, resolved]) != media_root:
                raise Http404
            resp = FileResponse(open(resolved, "rb"), content_type=content_type)
            resp["Content-Disposition"] = disposition
            return resp

        response = HttpResponse()
        response["X-Accel-Redirect"] = f"/protected-media/{path}"
        response["Content-Type"] = content_type
        response["Content-Disposition"] = disposition
        return response
