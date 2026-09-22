{{/*
Render-time validation. Fires during `helm template`, `helm install`, and
`helm upgrade` — before any resource is applied — so configuration errors
surface immediately instead of as a crash-looping migrate init container 90
seconds later.

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

{{- /*
    Only fails when the operator has actually configured an SMTP host via the
    chart. An empty host now means "I will configure email in Admin → Settings →
    Email after install" (#306), which is a supported flow and must not be
    blocked at render time — the old check keyed on backend.email.backend, which
    defaulted to "smtp", so it refused every install that intended to use the
    admin UI, and the escape hatch it suggested pinned EMAIL_BACKEND and
    disabled that UI too.

    A placeholder sender is still rejected: mail from example.com fails
    SPF/DMARC and silently breaks account recovery.
*/ -}}
{{- $from := .Values.backend.email.fromAddress -}}
{{- if .Values.backend.email.host }}
{{- if or (eq $from "") (contains "example.com" $from) }}
{{- fail "\n\nVisiban: backend.email.host is set but backend.email.fromAddress is empty or still points at example.com.\nVisiban refuses to send mail from a placeholder sender — it fails SPF/DMARC and silently breaks password resets.\n\nSet a real sender:\n    --set backend.email.fromAddress=noreply@yourdomain.com\n\nOr leave backend.email.host empty and configure email after install in Admin -> Settings -> Email.\n" -}}
{{- end }}
{{- end }}
{{- if and .Values.backend.email.useTls .Values.backend.email.useSsl }}
{{- fail "\n\nVisiban: backend.email.useTls and backend.email.useSsl cannot both be true.\nUse STARTTLS on port 587 (useTls), or implicit SSL on port 465 (useSsl).\n" -}}
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
