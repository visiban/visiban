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
