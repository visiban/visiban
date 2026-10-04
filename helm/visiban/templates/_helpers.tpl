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

The credentials are percent-encoded: a password containing "/", "?", "#", "["
or "]" otherwise splits the URL in the wrong place, and the backend refuses to
start ("%" and spaces would be mis-decoded). `openssl rand -base64`
emits "/" in roughly half of its outputs. urlquery encodes a space as "+",
which the backend's URL parser would keep literally, so it is rewritten to
%20 (a literal "+" is already %2B by then). Alphanumeric credentials render
unchanged.
*/}}
{{- define "visiban.urlCredential" -}}
{{- . | urlquery | replace "+" "%20" }}
{{- end }}

{{- define "visiban.databaseUrl" -}}
{{- if .Values.postgresql.enabled }}
{{- printf "postgres://%s:%s@%s-postgresql:5432/%s" (include "visiban.urlCredential" .Values.postgresql.auth.username) (include "visiban.urlCredential" .Values.postgresql.auth.password) .Release.Name .Values.postgresql.auth.database }}
{{- else }}
{{- printf "postgres://%s:%s@%s:%d/%s" (include "visiban.urlCredential" .Values.externalDatabase.username) (include "visiban.urlCredential" .Values.externalDatabase.password) .Values.externalDatabase.host (.Values.externalDatabase.port | int) .Values.externalDatabase.database }}
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
real limit. Derived from the larger of backend.settings.maxUploadSizeBytes (the
value wired into MAX_UPLOAD_SIZE_BYTES) and backend.settings.importMaxSizeBytes
(VISIBAN_IMPORT_MAX_SIZE, Trello import #456) plus 10 MB of multipart-framing
headroom, so raising
the application cap raises both transport limits with it and the two cannot
drift apart.

Consumed by templates/frontend-configmap.yaml (client_max_body_size) and
templates/ingress.yaml (nginx.ingress.kubernetes.io/proxy-body-size).
scripts/helm-structure-check.sh asserts both rendered limits clear the app cap.
*/}}
{{- define "visiban.transportBodyLimitMB" -}}
{{- $bytes := max (.Values.backend.settings.maxUploadSizeBytes | int) (.Values.backend.settings.importMaxSizeBytes | default 26214400 | int) | int -}}
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

{{/*
Public demo mode helpers (#1180).

Nil-safe on purpose. `helm upgrade --reuse-values` from a release that predates
the `demo:` block carries no `.Values.demo` at all, and `.Values.demo.enabled`
on a missing map is a raw nil-pointer render error on every upgrade — so every
template that decides WHETHER to render demo objects asks visiban.demoEnabled
instead of dereferencing the map. The loginHint halves are nil-safe for the
same reason TruePPM's are: `--set demo.loginHint=null` must reach the guard's
crafted message in _validate.tpl, not a Go nil-pointer error.
*/}}
{{- define "visiban.demoEnabled" -}}
{{- if (.Values.demo | default dict).enabled -}}true{{- end -}}
{{- end }}

{{- define "visiban.demoLoginUsername" -}}
{{- (dig "loginHint" "username" "" (.Values.demo | default dict)) | toString -}}
{{- end }}

{{- define "visiban.demoLoginPassword" -}}
{{- (dig "loginHint" "password" "" (.Values.demo | default dict)) | toString -}}
{{- end }}

{{/*
"true" when the scheduled reset CronJob renders. Default true inside demo mode,
matching values.yaml, so a hand-written `demo:` block that omits `reset` still
gets the reset the login page will promise.
*/}}
{{- define "visiban.demoResetEnabled" -}}
{{- if and (include "visiban.demoEnabled" .) (dig "reset" "enabled" true (.Values.demo | default dict)) -}}true{{- end -}}
{{- end }}

{{/*
The ONE statement of the reset cadence. Rendered into the CronJob's `schedule`
AND into the backend's DEMO_RESET_SCHEDULE (which drives the countdown), and
empty when the reset is disabled so the login page promises nothing that is not
running (TruePPM ADR-1197 D9, as amended 2026-09-21).
*/}}
{{- define "visiban.demoResetSchedule" -}}
{{- if include "visiban.demoResetEnabled" . -}}
{{- dig "reset" "schedule" "0 * * * *" (.Values.demo | default dict) | toString | trim -}}
{{- end -}}
{{- end }}

{{/*
The demo Secret: the published visitor password, and the admin and member
passwords that are never published. Separate from the runtime Secret so it is
chart-managed even when secret.existingSecret is set.
*/}}
{{- define "visiban.demoSecretName" -}}
{{- printf "%s-demo" (include "visiban.fullname" .) -}}
{{- end }}

{{- define "visiban.demoSecretData" -}}
demo-login-password: {{ include "visiban.demoLoginPassword" . | quote }}
demo-admin-password: {{ .Values.demo.adminPassword | toString | quote }}
demo-member-password: {{ .Values.demo.memberPassword | toString | quote }}
{{- end }}

{{/*
Components whose pods open a datastore connection — the single list both the
datastore ingress allow-lists and the demo egress policy are built from, so the
two can never disagree about who is a datastore client. `demo-seed` is the demo
seed hook AND the reset CronJob (templates/demo-seed-job.yaml,
templates/demo-reset-cronjob.yaml). It is added only while demo mode is on, so
a release without it renders exactly the policies it did before #1180.
scripts/helm-structure-check.sh section 7 asserts every rendered workload is on
the list or deliberately excluded, for the default AND the demo render.
*/}}
{{- define "visiban.datastoreClients" -}}
backend scheduler{{ if include "visiban.demoEnabled" . }} demo-seed{{ end }}
{{- end }}

{{/*
Hardened pod/container securityContext defaults (#1210, frontend added in
#1224), with a hardcoded fallback for the case where the whole block is
absent from .Values rather than merely unset at a field level.

Helm's own values coalescing (chartutil.CoalesceValues) already deep-merges
any `-f`/`--set`/`--reuse-values` override with the CURRENT chart's
values.yaml, so a render that overrides only one field (e.g.
`readOnlyRootFilesystem: false`) already sees the rest of this chart's
hardened defaults for the others — nothing here needs to re-merge that.
DON'T reach for Sprig's `merge` to "help" here: `merge $override $defaults`
uses mergo, which treats Go zero values (`false`, `0`, `""`) in $override as
*unset* and silently replaces them with $defaults — so a deliberate
`readOnlyRootFilesystem: false` override would be silently overwritten back
to `true`. (Confirmed: `merge (dict "a" false) (dict "a" true")` renders
`a: true`.) These templates therefore pass an already-resolved
`.pod`/`.container` value straight through unchanged, and only supply the
hardcoded default when the value is genuinely absent (`kindIs "invalid"` —
how a template sees Go's untyped nil).
Called as `include "visiban.postgresql.securityContext.pod" (.Values.postgresql.securityContext | default dict)`
— the `| default dict` at the call site guards against `.securityContext`
itself being absent, so `.pod`/`.container` here never index into a nil map.
*/}}
{{- define "visiban.backend.securityContext.pod" -}}
{{- if kindIs "invalid" .pod -}}
runAsNonRoot: true
runAsUser: 1001
runAsGroup: 1001
seccompProfile:
  type: RuntimeDefault
{{- else -}}
{{- toYaml .pod }}
{{- end -}}
{{- end }}

{{- define "visiban.backend.securityContext.container" -}}
{{- if kindIs "invalid" .container -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- else -}}
{{- toYaml .container }}
{{- end -}}
{{- end }}

{{- define "visiban.postgresql.securityContext.pod" -}}
{{- if kindIs "invalid" .pod -}}
runAsNonRoot: true
runAsUser: 999
runAsGroup: 999
fsGroup: 999
seccompProfile:
  type: RuntimeDefault
{{- else -}}
{{- toYaml .pod }}
{{- end -}}
{{- end }}

{{- define "visiban.postgresql.securityContext.container" -}}
{{- if kindIs "invalid" .container -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- else -}}
{{- toYaml .container }}
{{- end -}}
{{- end }}

{{- define "visiban.frontend.securityContext.pod" -}}
{{- if kindIs "invalid" .pod -}}
runAsNonRoot: true
runAsUser: 101
runAsGroup: 101
seccompProfile:
  type: RuntimeDefault
{{- else -}}
{{- toYaml .pod }}
{{- end -}}
{{- end }}

{{- define "visiban.frontend.securityContext.container" -}}
{{- if kindIs "invalid" .container -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- else -}}
{{- toYaml .container }}
{{- end -}}
{{- end }}

{{/*
Pod spec shared by the demo seed hook and the demo reset CronJob (#1180).

ONE definition on purpose: the reset must be exactly the install-time seed, run
on a timer. If the two drifted, the published password or the seed state after
a reset could differ from what a fresh install produces, and the login hint
could end up pointing at an account that no longer opens.
scripts/helm-structure-check.sh section 9 asserts both renders stay identical.

  - `migrate` init container first: Helm does not wait for the backend to be
    Ready before firing a post-install hook unless --wait is passed, and a reset
    can land mid-upgrade, so the seed must never run against an unmigrated
    schema. `migrate_with_lock` serializes it with the backend pod's own migrate
    init container on the same PostgreSQL advisory lock (#1117).
  - `seed_demo_data --force --wipe --demo-site --reset-database`: empties EVERY
    table (sessions included, so every visitor is signed out, as the login page
    warns), then reseeds, re-applying the published visitor password from
    DEMO_LOGIN_PASSWORD on every run. `--demo-site` refuses to run unless
    DEMO_MODE is on, so this command cannot empty a non-demo database.
  - Pods carry `app.kubernetes.io/component: demo-seed`, which is on the
    datastore allow-list and in the demo egress policy (networkpolicy.yaml).
  - No readiness coupling: nothing in the backend depends on this pod
    succeeding. A failed reset leaves the previous (stale) demo data up and a
    failed Job to `kubectl logs`; it never takes the demo down (TruePPM ADR-1197
    D9).
*/}}
{{- define "visiban.demoSeedPodSpec" -}}
restartPolicy: Never
automountServiceAccountToken: false
securityContext:
  runAsNonRoot: true
  # The backend image's `visiban` user (backend/Dockerfile). Numeric because the
  # kubelet cannot verify runAsNonRoot against a user NAME.
  runAsUser: 1001
  runAsGroup: 1001
  seccompProfile:
    type: RuntimeDefault
volumes:
  - name: tmp
    emptyDir: {}
  # The base demo board seeds one small attachment, and the root filesystem is
  # read-only. The file lands in this pod's own scratch volume, NOT in the
  # backend pod's media (demo mode has no shared media volume by design: the
  # media PVC is refused), so that one seeded attachment has no file behind it
  # on the served instance and its download answers 404.
  - name: media
    emptyDir: {}
initContainers:
  - name: migrate
    image: "{{ .Values.backend.image.repository }}:{{ .Values.backend.image.tag }}"
    imagePullPolicy: {{ .Values.backend.image.pullPolicy }}
    command: ["python", "manage.py", "migrate_with_lock"]
    env:
      {{- include "visiban.backendEnv" . | nindent 6 }}
      - name: VISIBAN_MIGRATE_CONNECT_TIMEOUT
        value: {{ .Values.backend.migrate.connectTimeout | int | quote }}
      - name: VISIBAN_MIGRATE_LOCK_TIMEOUT
        value: {{ .Values.backend.migrate.lockTimeout | int | quote }}
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities:
        drop: ["ALL"]
    volumeMounts:
      - name: tmp
        mountPath: /tmp
    resources:
      {{- toYaml .Values.demo.resources | nindent 6 }}
containers:
  - name: demo-seed
    image: "{{ .Values.backend.image.repository }}:{{ .Values.backend.image.tag }}"
    imagePullPolicy: {{ .Values.backend.image.pullPolicy }}
    command: ["python", "manage.py", "seed_demo_data", "--force", "--wipe", "--demo-site", "--reset-database"]
    env:
      {{- include "visiban.backendEnv" . | nindent 6 }}
      # Seed-only: the backend never needs these two, so they are not in
      # visiban.demoEnv and never reach the serving pod.
      - name: DEMO_ADMIN_PASSWORD
        valueFrom:
          secretKeyRef:
            name: {{ include "visiban.demoSecretName" . }}
            key: demo-admin-password
      - name: DEMO_MEMBER_PASSWORD
        valueFrom:
          secretKeyRef:
            name: {{ include "visiban.demoSecretName" . }}
            key: demo-member-password
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities:
        drop: ["ALL"]
    volumeMounts:
      - name: tmp
        mountPath: /tmp
      - name: media
        mountPath: /app/media
    resources:
      {{- toYaml .Values.demo.resources | nindent 6 }}
{{- end }}

{{/*
Host header for in-pod callers of the backend (kubelet probes, helm tests).
The first operator-configured ALLOWED_HOSTS entry, so those callers pass Django's
host validation without ALLOWED_HOSTS being widened with localhost (#1230). A
leading dot (".example.com", Django's subdomain wildcard) is stripped so the
result is a concrete hostname that the same pattern matches. A "*" or empty
value accepts any Host, so "localhost" is as good as anything there.
*/}}
{{- define "visiban.probeHost" -}}
{{- $h := index (splitList "," (toString .Values.backend.settings.allowedHosts)) 0 | trim | trimPrefix "." -}}
{{- if or (eq $h "") (eq $h "*") -}}localhost{{- else -}}{{- $h -}}{{- end -}}
{{- end }}

{{/*
The catch-all / loopback entries of backend.settings.allowedHosts (#1360), as a
comma-separated, quoted list ("" when there are none). Exact per-entry match
after trim + lowercase, so "localhost.example.com" is not one. Shared by the
render guard in _validate.tpl and the opt-in warning in NOTES.txt so the two
can never disagree about what counts.

Leading dots are stripped before the check: Django's ".x" pattern matches the
bare "x" too, so ".localhost" and ".127.0.0.1" are as open as their bare forms.
The regex catches the IPv6 loopback/unspecified address in any zero-padded or
compressed spelling ("[0:0:0:0:0:0:0:1]", "[0::1]", "[::]", "::"), plus the
bare "0" short form of 0.0.0.0. Best effort over the names a copy-pasted dev
config carries; other 127/8 addresses are deliberately not listed.
*/}}
{{- define "visiban.unsafeAllowedHosts" -}}
{{- $unsafe := list "*" "localhost" "localhost.localdomain" "ip6-localhost" "127.0.0.1" "0.0.0.0" "[::ffff:127.0.0.1]" -}}
{{- $found := list -}}
{{- range splitList "," (toString .Values.backend.settings.allowedHosts) -}}
{{- $e := lower (trim .) -}}
{{- $bare := regexReplaceAll "^\\.+" $e "" -}}
{{- if and (or (has $bare $unsafe) (regexMatch "^\\[?[0:]+1?\\]?$" $bare)) (not (has (quote $e) $found)) -}}
{{- $found = append $found (quote $e) -}}
{{- end -}}
{{- end -}}
{{- join ", " $found -}}
{{- end }}

{{/*
Bundled Valkey password auth (#1211). Opt-in: valkey.auth.enabled defaults to
false, and every helper below renders nothing on that path, so an install that
does not turn auth on renders what it did before #1211. The one difference is
a reworded comment in the Valkey ConfigMap, and checksum/config hashes only
valkey.commonConfiguration, so that causes no restart.

No checksum annotation for the password, on Valkey or the backend: `get pods`
is a weaker permission than `get secrets`, and an unsalted hash of a weak
password cracks offline. No salt is secret in every mode (secret.djangoSecretKey
is a placeholder under secret.existingSecret). So rotating the password needs a
manual `kubectl rollout restart`, as documented.

Nil-safe (`dig`) for the same reason as the demo helpers: `helm upgrade
--reuse-values` from a release whose values carry no valkey.auth map must not
hit a nil-pointer render error.

The password reaches pods ONLY through a secretKeyRef — never a ConfigMap, a
plain env `value`, or a URL rendered by the chart:
  - Valkey reads it from the REDISCLI_AUTH env var: the server is started with
    `--requirepass "$REDISCLI_AUTH"`, and valkey-cli picks the same variable up
    on its own, so the liveness/readiness probes authenticate unchanged.
  - The backend reads it from REDIS_URL_PASSWORD, and settings.py
    (_apply_redis_password) percent-encodes it into REDIS_URL/REDIS_CACHE_URL.
    REDIS_URL itself stays the plain, password-free URL it always was.
Doing the encoding in the backend rather than here is what lets an
existingSecret holding ANY password work: Helm cannot read that Secret at render
time to `urlquery` it, and Kubernetes' $(VAR) env expansion does no encoding,
so a "/" or "@" in it would split the URL (the #1229 defect class).
*/}}
{{- define "visiban.valkeyAuthEnabled" -}}
{{- if and .Values.valkey.enabled (dig "auth" "enabled" false (.Values.valkey | default dict)) -}}true{{- end -}}
{{- end }}

{{- define "visiban.valkeyAuthSecretName" -}}
{{- $auth := dig "auth" dict (.Values.valkey | default dict) -}}
{{- if $auth.existingSecret -}}
{{- $auth.existingSecret -}}
{{- else -}}
{{- printf "%s-valkey-auth" (include "visiban.fullname" .) -}}
{{- end -}}
{{- end }}

{{- define "visiban.valkeyAuthSecretKey" -}}
{{- (dig "auth" "existingSecretPasswordKey" "" (.Values.valkey | default dict)) | default "valkey-password" -}}
{{- end }}

{{/*
The REDISCLI_AUTH / REDIS_URL_PASSWORD env entry's valueFrom, shared by the
Valkey container and visiban.backendEnv so the two can never read different
Secrets or keys.
*/}}
{{- define "visiban.valkeyAuthValueFrom" -}}
valueFrom:
  secretKeyRef:
    name: {{ include "visiban.valkeyAuthSecretName" . }}
    key: {{ include "visiban.valkeyAuthSecretKey" . }}
{{- end }}

{{/*
External Valkey/Redis password from a Secret (#1361). The external-instance
half of #1211: with valkey.enabled=false the backend reads the password from
externalRedis.existingSecret as REDIS_URL_PASSWORD, through the same
settings.py path (_apply_redis_password) that percent-encodes it into
externalRedis.url / cacheUrl. Without this, the only way to reach a
password-protected external instance was to put the password in those URLs,
which the chart renders as plain env values (visible in the Deployment spec and
`helm get manifest`).

Opt-in and additive: with externalRedis.existingSecret unset (every install
before #1361) nothing below renders, so a URL that carries its own password
keeps working byte-for-byte. The password is never chart-managed here: an
operator who wants the chart to hold it can keep it in the URL as before, and a
chart-managed Secret would only move the plaintext into the release record.

Nil-safe (`dig`) because `helm upgrade --reuse-values` from a release whose
values predate these keys carries an externalRedis map without them.
*/}}
{{- define "visiban.externalRedisAuthEnabled" -}}
{{- if and (not .Values.valkey.enabled) (dig "existingSecret" "" (.Values.externalRedis | default dict)) -}}true{{- end -}}
{{- end }}

{{- define "visiban.externalRedisAuthSecretKey" -}}
{{- (dig "existingSecretPasswordKey" "" (.Values.externalRedis | default dict)) | default "redis-password" -}}
{{- end }}
