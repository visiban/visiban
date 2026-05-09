{{/*
Render-time validation. Fires during `helm template`, `helm install`, and
`helm upgrade` — before any resource is applied — so configuration errors
surface immediately instead of as a hung migrate Job 90 seconds later.

Each block uses Helm's `fail` to stop rendering with a friendly, actionable
message (copy-pasteable command + the exact `--set` flag). Soft warnings live
in NOTES.txt where they don't block render.

Skipped entirely when secret.existingSecret is set, since the chart doesn't
manage the Secret in that case and cannot inspect its contents.
*/}}
{{- define "visiban.validate" -}}
{{- $key := .Values.secret.djangoSecretKey -}}
{{- if not .Values.secret.existingSecret }}
{{- if or (eq $key "") (eq $key "change-me-in-production") }}
{{- fail "\n\nVisiban: secret.djangoSecretKey is empty or set to the chart's placeholder.\n\nGenerate a secure key with:\n    python3 -c 'import secrets; print(secrets.token_hex(50))'\n\n…then pass it via:\n    --set-string secret.djangoSecretKey=<key>\nor in your values.secret.yaml file.\n" -}}
{{- end }}
{{- end }}

{{- if eq .Values.backend.email.backend "smtp" }}
{{- $from := .Values.backend.email.fromAddress -}}
{{- if or (eq $from "") (contains "example.com" $from) }}
{{- fail "\n\nVisiban: backend.email.fromAddress is empty or still points at example.com.\nDjango will refuse to start when EMAIL_BACKEND is smtp without a real From: address.\n\nSet a real sender:\n    --set backend.email.fromAddress=noreply@yourdomain.com\n\nOr switch to the console backend (logs emails instead of sending):\n    --set backend.email.backend=console\n" -}}
{{- end }}
{{- end }}

{{- if contains "visiban.example.com" .Values.backend.settings.allowedHosts }}
{{- fail "\n\nVisiban: backend.settings.allowedHosts still contains the placeholder visiban.example.com.\nDjango will reject any request whose Host header is not in this list.\n\nSet your real hostname(s) (comma-separated):\n    --set backend.settings.allowedHosts=boards.yourdomain.com\n" -}}
{{- end }}

{{- if and .Values.postgresql.subchartEnabled (not .Values.postgresql.auth.existingSecret) }}
{{- if eq .Values.postgresql.auth.password "visiban" }}
{{- fail "\n\nVisiban: postgresql.auth.password is set to the chart's placeholder \"visiban\".\nThis is the literal default — anyone with access to the source can guess it.\n\nGenerate a strong password and pass it via:\n    --set-string postgresql.auth.password=<password>\nor in your values.secret.yaml file.\n" -}}
{{- end }}
{{- end }}
{{- end }}
