{{/*
Expand the name of the chart.
*/}}
{{- define "visiban.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "visiban.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart label
*/}}
{{- define "visiban.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "visiban.labels" -}}
helm.sh/chart: {{ include "visiban.chart" . }}
app.kubernetes.io/name: {{ include "visiban.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Backend selector labels
*/}}
{{- define "visiban.backend.selectorLabels" -}}
app.kubernetes.io/name: {{ include "visiban.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: backend
{{- end }}

{{/*
Frontend selector labels
*/}}
{{- define "visiban.frontend.selectorLabels" -}}
app.kubernetes.io/name: {{ include "visiban.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: frontend
{{- end }}

{{/*
Name of the Secret containing backend credentials (Django key, DB URL, OAuth).
Uses an existing Secret if secret.existingSecret is set, otherwise the chart-managed one.
*/}}
{{- define "visiban.secretName" -}}
{{- if .Values.secret.existingSecret }}
{{- .Values.secret.existingSecret }}
{{- else }}
{{- include "visiban.fullname" . }}
{{- end }}
{{- end }}

{{/*
Name of the Secret containing the PostgreSQL password.
Uses an existing Secret if postgresql.auth.existingSecret is set.
*/}}
{{- define "visiban.postgresql.secretName" -}}
{{- if .Values.postgresql.auth.existingSecret }}
{{- .Values.postgresql.auth.existingSecret }}
{{- else }}
{{- printf "%s-postgresql" (include "visiban.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Database URL — built from postgresql subchart or externalDatabase values.
*/}}
{{- define "visiban.databaseUrl" -}}
{{- if .Values.postgresql.enabled }}
{{- printf "postgres://%s:%s@%s-postgresql:5432/%s" .Values.postgresql.auth.username .Values.postgresql.auth.password .Release.Name .Values.postgresql.auth.database }}
{{- else }}
{{- printf "postgres://%s:%s@%s:%d/%s" .Values.externalDatabase.username .Values.externalDatabase.password .Values.externalDatabase.host (.Values.externalDatabase.port | int) .Values.externalDatabase.database }}
{{- end }}
{{- end }}

{{/*
Name of the Secret containing the SMTP password — the operator-supplied one
when backend.email.existingSecret is set, otherwise the chart-managed Secret.
*/}}
{{- define "visiban.emailSecretName" -}}
{{- if .Values.backend.email.existingSecret -}}
{{- .Values.backend.email.existingSecret -}}
{{- else -}}
{{- include "visiban.secretName" . -}}
{{- end -}}
{{- end }}

{{/*
Key/value body of the chart-managed runtime Secret.

Also checksummed into the backend Deployment's pod template annotations, so a
rotation of ANY value here forces a rollout — which is what makes the rotation
reach both the running app and the `migrate` init container. There was a second,
hook-managed copy of this Secret until #1117; it existed only so a pre-upgrade
migrate Job could read a rotated value, and it went away with the Job.
*/}}
{{- define "visiban.secretData" -}}
django-secret-key: {{ .Values.secret.djangoSecretKey | quote }}
database-url: {{ include "visiban.databaseUrl" . | quote }}
google-client-id: {{ .Values.backend.oauth.google.clientId | quote }}
google-client-secret: {{ .Values.backend.oauth.google.clientSecret | quote }}
github-client-id: {{ .Values.backend.oauth.github.clientId | quote }}
github-client-secret: {{ .Values.backend.oauth.github.clientSecret | quote }}
gitlab-client-id: {{ .Values.backend.oauth.gitlab.clientId | quote }}
gitlab-client-secret: {{ .Values.backend.oauth.gitlab.clientSecret | quote }}
{{- if .Values.backend.oauth.oidc.serverUrl }}
oidc-client-id: {{ .Values.backend.oauth.oidc.clientId | quote }}
oidc-client-secret: {{ .Values.backend.oauth.oidc.clientSecret | quote }}
{{- end }}
{{- if and (eq .Values.backend.email.backend "smtp") (not .Values.backend.email.existingSecret) }}
{{ .Values.backend.email.passwordKey | default "email-password" }}: {{ .Values.backend.email.password | quote }}
{{- end }}
{{- end }}

{{/*
Transport body limit, in whole megabytes (#1116).

The edge must accept a request that the APPLICATION is still willing to reject
itself — otherwise an over-cap upload dies at nginx or the ingress controller
with a bare 413 and Django never sees it, so the user gets no message naming the
real limit. Derived from backend.settings.maxUploadSizeBytes (the value wired
into MAX_UPLOAD_SIZE_BYTES) plus 10 MB of multipart-framing headroom, so raising
the application cap raises both transport limits with it and the two cannot
drift apart.

Consumed by templates/frontend-configmap.yaml (client_max_body_size) and
templates/ingress.yaml (nginx.ingress.kubernetes.io/proxy-body-size).
scripts/helm-structure-check.sh asserts both rendered limits clear the app cap.
*/}}
{{- define "visiban.transportBodyLimitMB" -}}
{{- $bytes := .Values.backend.settings.maxUploadSizeBytes | int -}}
{{- $mb := div $bytes 1048576 -}}
{{- if gt (mod $bytes 1048576) 0 -}}
{{- $mb = add1 $mb -}}
{{- end -}}
{{- add $mb 10 -}}
{{- end }}

{{/*
Frontend selector as a kubectl `-l` argument: comma-joined key=value pairs.

visiban.frontend.selectorLabels emits YAML (`key: value`, one per line), which
is correct inside a manifest and produces a broken, three-line shell command
when interpolated into `kubectl get pods -l "..."` in NOTES.txt — the first
thing the chart tells an operator to run.
*/}}
{{- define "visiban.frontend.selectorArg" -}}
app.kubernetes.io/name={{ include "visiban.name" . }},app.kubernetes.io/instance={{ .Release.Name }},app.kubernetes.io/component=frontend
{{- end }}
