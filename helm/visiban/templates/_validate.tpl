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

{{- /* An empty list renders ALLOWED_HOSTS="" (the chart no longer appends localhost, #1230): Django rejects every request and no pod ever becomes ready. */ -}}
{{- if eq (trim (toString .Values.backend.settings.allowedHosts)) "" }}
{{- fail "\n\nVisiban: backend.settings.allowedHosts is empty.\nDjango would reject every request (including the pod's own probes) and no pod would become ready.\n\nSet your real hostname(s) (comma-separated):\n    --set backend.settings.allowedHosts=boards.yourdomain.com\n" -}}
{{- end }}

{{- if contains "visiban.example.com" .Values.backend.settings.allowedHosts }}
{{- fail "\n\nVisiban: backend.settings.allowedHosts still contains the placeholder visiban.example.com.\nDjango will reject any request whose Host header is not in this list.\n\nSet your real hostname(s) (comma-separated):\n    --set backend.settings.allowedHosts=boards.yourdomain.com\n" -}}
{{- end }}

{{- if and .Values.postgresql.subchartEnabled (not .Values.postgresql.auth.existingSecret) }}
{{- if eq .Values.postgresql.auth.password "visiban" }}
{{- fail "\n\nVisiban: postgresql.auth.password is set to the chart's placeholder \"visiban\".\nThis is the literal default — anyone with access to the source can guess it.\n\nGenerate a strong password and pass it via:\n    --set-string postgresql.auth.password=<password>\nor in your values.secret.yaml file.\n" -}}
{{- end }}
{{- end }}
{{- include "visiban.valkeyGuards" . }}
{{- include "visiban.demoGuards" . }}
{{- end }}

{{/*
Bundled Valkey guards (#1200). Until chart 0.5.0 the `valkey` block configured
the bitnami/valkey subchart; templates/valkey.yaml now reads it. A leftover
subchart value that would CHANGE what runs, if the chart silently ignored it,
fails the render here instead — a values file that asked for replicas, a
password or a Bitnami image must not quietly get something else.
*/}}
{{- define "visiban.valkeyGuards" -}}
{{- if .Values.valkey.enabled -}}
{{- $v := .Values.valkey -}}
{{- if ne (toString ($v.architecture | default "standalone")) "standalone" -}}
{{- fail (printf "\n\nVisiban: valkey.architecture is %q, but the bundled Valkey is standalone only (chart 0.5.0+, #1200).\nThe backend only ever connected to the primary, so the old subchart's replicas were never used.\n\nRemove the override:\n    --set valkey.architecture=standalone\nor point externalRedis at a replicated instance with --set valkey.enabled=false.\n" (toString $v.architecture)) -}}
{{- end -}}
{{- if (dig "auth" "enabled" false $v) -}}
{{- fail "\n\nVisiban: valkey.auth.enabled is true, but the bundled Valkey does not support a password: REDIS_URL carries none, so this setting has never produced a working deploy (#1200).\nAccess to the bundled Valkey is restricted by NetworkPolicy (networkPolicy.enabled=true).\n\nEither remove the override:\n    --set valkey.auth.enabled=false\nor use a password-protected instance through externalRedis:\n    --set valkey.enabled=false --set externalRedis.url=redis://:<password>@host:6379/0 --set externalRedis.cacheUrl=redis://:<password>@host:6379/1\n" -}}
{{- end -}}
{{- /*
  `helm upgrade --reuse-values` from a subchart-era release carries the
  subchart's image defaults: registry registry-1.docker.io, repository
  bitnami/valkey, tag latest. The registry is Docker Hub, where the official
  image also lives, so a Docker Hub registry is treated as unset — otherwise the
  fix this guard prints (repository + tag) would not clear it, and the operator
  would get the same message back. Any OTHER registry is refused: the template
  never reads the key, and a mirror has to be named in `repository`.
*/ -}}
{{- $img := $v.image | default dict -}}
{{- $repo := toString ($img.repository | default "") -}}
{{- $tag := toString ($img.tag | default "") -}}
{{- $registry := toString ($img.registry | default "") -}}
{{- $fix := "\n\nUse the official image:\n    --set valkey.image.repository=valkey/valkey --set valkey.image.tag=8-alpine\n\nIf this is `helm upgrade --reuse-values` from a chart before 0.5.0, the old Bitnami values come from the previous release: pass the two flags above, or upgrade with --reset-then-reuse-values (Helm 3.14+) to take this chart's defaults. See \"Helm: bundled Valkey is no longer the Bitnami subchart\" in docs/administration/upgrade.md.\n" -}}
{{- if contains "bitnami" $repo -}}
{{- fail (printf "\n\nVisiban: valkey.image.repository is %q, a Bitnami image. The bundled Valkey now runs the official image with its own config (chart 0.5.0+, #1200); a Bitnami image does not start under it.%s" $repo $fix) -}}
{{- end -}}
{{- if not (has $registry (list "" "docker.io" "registry-1.docker.io" "index.docker.io")) -}}
{{- fail (printf "\n\nVisiban: valkey.image.registry is %q. The bundled Valkey (chart 0.5.0+, #1200) does not read that key, so the image would silently come from Docker Hub instead.\n\nPut a mirror in the repository and drop the registry:\n    --set valkey.image.registry=null --set valkey.image.repository=%s/valkey/valkey --set valkey.image.tag=8-alpine\n" $registry $registry) -}}
{{- end -}}
{{- if or (eq $repo "") (eq $tag "") (eq $tag "latest") -}}
{{- fail (printf "\n\nVisiban: valkey.image must name a repository and a pinned tag (got %q:%q). An empty or \"latest\" tag drifts across Valkey majors on every pod reschedule (#1200).%s" $repo $tag $fix) -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
Render-time guards for public demo mode (#1180), ported from TruePPM's
trueppm.demoGuards (_helpers.tpl, ADR-1197 D5/D6/D7). Nothing is emitted on the
happy path — every branch either fails the render or produces no output. Each
guard has a failing-render case in scripts/helm-structure-check.sh section 10.

"Fail the render, never sanitize at use": a value that could close a quote is
refused here rather than escaped wherever it is used.
*/}}
{{- define "visiban.demoGuards" -}}
{{- $demo := .Values.demo | default dict -}}
{{- $user := include "visiban.demoLoginUsername" . -}}
{{- $pass := include "visiban.demoLoginPassword" . -}}
{{- /*
  The dangerous direction first: a login hint with the fence OFF publishes a
  WORKING credential to a WRITABLE instance. A missing hint only breaks a demo;
  this one hands the internet an account.
*/ -}}
{{- if and (or $user $pass) (not (include "visiban.demoEnabled" .)) -}}
{{- fail "\n\nVisiban: demo.loginHint is set but demo.enabled is false.\nDEMO_MODE would not be rendered, so the write fence (DemoModeMiddleware) is OFF — this would publish a working login to a WRITABLE instance.\n\nEither turn the demo on (start from values-demo.yaml):\n    --set demo.enabled=true\nor clear demo.loginHint.\n" -}}
{{- end -}}
{{- if include "visiban.demoEnabled" . -}}
{{- if not (and $user $pass) -}}
{{- fail "\n\nVisiban: demo.enabled is true but demo.loginHint.username and demo.loginHint.password are not both set.\nThe public demo IS a published login: without one the login page has nothing to offer, the seed creates no visitor, and `helm test` fails.\n\nSet both to the credential you intend to publish, e.g.:\n    --set demo.loginHint.username=visitor\n    --set demo.loginHint.password=\"$(openssl rand -base64 18 | tr -d '=+/')\"\n" -}}
{{- end -}}
{{- if not (regexMatch "^[A-Za-z0-9._@+-]{1,150}$" $user) -}}
{{- fail "\n\nVisiban: demo.loginHint.username may contain only letters, digits and . _ @ + - (max 150 characters). It is published on the login page and sent in the `helm test` request body.\n" -}}
{{- end -}}
{{- if has (lower $user) (list "admin" "maya" "jordan") -}}
{{- fail "\n\nVisiban: demo.loginHint.username must not be admin, maya or jordan — the demo seed uses those names for the site admin and the two member accounts, and would refuse to run. Use a dedicated name such as \"visitor\".\n" -}}
{{- end -}}
{{- if not (regexMatch "^[A-Za-z0-9._@+~!*=:,;?-]{8,128}$" $pass) -}}
{{- fail "\n\nVisiban: demo.loginHint.password must be 8-128 characters of letters, digits and . _ @ + ~ ! * = : , ; ? - (no quotes, spaces, backslashes or $).\nIt is published, so secrecy is not the point, but it must be unique to this demo and inert in shell and JSON. Generate one with:\n    openssl rand -base64 18 | tr -d '=+/'\n" -}}
{{- end -}}
{{- $admin := $demo.adminPassword | default "" | toString -}}
{{- $member := $demo.memberPassword | default "" | toString -}}
{{- if not $admin -}}
{{- fail "\n\nVisiban: demo.adminPassword is required when demo.enabled is true.\nIt is the demo site admin's password: never published, and the seed refuses to create an admin without one.\n    --set-string demo.adminPassword=\"$(openssl rand -base64 24)\"\n" -}}
{{- end -}}
{{- if not $member -}}
{{- fail "\n\nVisiban: demo.memberPassword is required when demo.enabled is true.\nIt is the password of the two seeded member accounts (not published); the seed refuses to run without it.\n    --set-string demo.memberPassword=\"$(openssl rand -base64 24)\"\n" -}}
{{- end -}}
{{- if or (eq $admin $pass) (eq $member $pass) -}}
{{- fail "\n\nVisiban: demo.adminPassword and demo.memberPassword must differ from demo.loginHint.password.\nThe login hint is PUBLISHED; reusing it would publish the admin or member credential too. The published password must open exactly one unprivileged account.\n" -}}
{{- end -}}
{{- $oauth := .Values.backend.oauth -}}
{{- if or $oauth.google.clientId $oauth.github.clientId $oauth.gitlab.clientId $oauth.oidc.serverUrl -}}
{{- fail "\n\nVisiban: demo.enabled is true but an SSO/OAuth provider is configured (backend.oauth.*).\nA public demo signs in only with the published password. A social login would let visitors create accounts the seed did not make and would need egress the demo NetworkPolicy denies.\n\nClear backend.oauth.google/github/gitlab.clientId and backend.oauth.oidc.serverUrl.\n" -}}
{{- end -}}
{{- if or (eq (toString .Values.backend.email.backend) "smtp") .Values.backend.email.host -}}
{{- fail "\n\nVisiban: demo.enabled is true but real SMTP is configured (backend.email.backend=smtp or backend.email.host set).\nA public demo must not be able to send mail to arbitrary addresses, and the demo NetworkPolicy denies the egress anyway.\n\nUse:\n    --set backend.email.backend=console --set backend.email.host=\"\"\n" -}}
{{- end -}}
{{- if .Values.backend.mediaPersistence.enabled -}}
{{- fail "\n\nVisiban: demo.enabled is true and backend.mediaPersistence.enabled is true.\nPublic demo mode gives visitors no upload path (the fence refuses uploads and the seed turns uploads off); a writable media PVC is defense in depth against a hole in that, so it is refused:\n    --set backend.mediaPersistence.enabled=false\n" -}}
{{- end -}}
{{- /*
  django-environ's env.bool() (environ.py's parse_value) casts by trying
  int(value) != 0 FIRST, and only falls back to a string membership check
  (BOOLEAN_TRUE_STRINGS, case-insensitive, trimmed) if that raises. So "2",
  "01" and "-1" are true via the int path (a re-check by completeness-check
  found the first version of this guard, which only checked string
  membership, missed exactly these) -- as well as every non-"true" string in
  BOOLEAN_TRUE_STRINGS. A guard that only caught "true" would let any of
  these through to a public demo with Django's debug pages served, the
  /admin/ IP allowlist off, and throttles raised to 9999/hour (#1180).
*/ -}}
{{- $debugRaw := trim (toString .Values.backend.settings.debug) -}}
{{- $debugTruthy := false -}}
{{- if regexMatch "^-?[0-9]+$" $debugRaw -}}
{{- $debugTruthy = ne (atoi $debugRaw) 0 -}}
{{- else if has (lower $debugRaw) (list "true" "on" "ok" "y" "yes") -}}
{{- $debugTruthy = true -}}
{{- end -}}
{{- if $debugTruthy -}}
{{- fail "\n\nVisiban: demo.enabled is true and backend.settings.debug is a truthy value.\nA public instance must never serve Django's debug pages.\n    --set backend.settings.debug=false\n" -}}
{{- end -}}
{{- if not .Values.networkPolicy.enabled -}}
{{- fail "\n\nVisiban: demo.enabled is true but networkPolicy.enabled is false.\nPublic demo mode renders an EGRESS policy that limits the backend, seed and reset pods to DNS and the release's own datastores (TruePPM ADR-1197 D7); it lives in the NetworkPolicy template.\n    --set networkPolicy.enabled=true\n" -}}
{{- end -}}
{{- if or (not .Values.postgresql.enabled) (not .Values.valkey.enabled) -}}
{{- fail "\n\nVisiban: demo.enabled is true but postgresql.enabled and/or valkey.enabled is false.\nThe demo egress policy allows only DNS and the release's OWN bundled PostgreSQL and Valkey pods; it has no rule for an external database, so rendering it would cut the backend off from its datastore. Use the bundled datastores for a demo.\n" -}}
{{- end -}}
{{- if kindIs "invalid" .Values.backend.settings.numProxies -}}
{{- fail "\n\nVisiban: demo.enabled is true but backend.settings.numProxies is not set.\nLeaving it unset silently keeps NUM_PROXIES=1: behind a reverse proxy chain (e.g. a Cloudflare Tunnel in front of this chart's own frontend nginx), that collapses every visitor onto the tunnel's own address, so the per-IP login/anon throttles become one shared bucket — the exact DoS this setting exists to prevent (#1180).\n\nSet it to the number of trusted proxies between the internet and this chart's frontend Service (values-demo.yaml sets 2 for a Cloudflare Tunnel; use 1 if the frontend Service is exposed directly, with nothing in front of it):\n    --set backend.settings.numProxies=2\n" -}}
{{- else if lt (int .Values.backend.settings.numProxies) 1 -}}
{{- fail "\n\nVisiban: demo.enabled is true but backend.settings.numProxies is less than 1.\nThis chart's own frontend nginx always sits in front of the backend, so 0 means every visitor resolves to the frontend pod's address — one shared throttle bucket for everyone (completeness-check, #1180).\n\nSet it to at least 1 (2 behind a Cloudflare Tunnel, per values-demo.yaml):\n    --set backend.settings.numProxies=2\n" -}}
{{- end -}}
{{- if include "visiban.demoResetEnabled" . -}}
{{- if not (regexMatch "^(@(hourly|daily|midnight)|[0-9*/,-]+ [0-9*/,-]+ \\* \\* \\*)$" (include "visiban.demoResetSchedule" .)) -}}
{{- fail "\n\nVisiban: demo.reset.schedule must be a minute/hour cron expression such as \"0 * * * *\" (day-of-month, month and day-of-week must be *), or @hourly/@daily/@midnight.\nThe backend derives the countdown visitors see from the same string and refuses to start on anything else.\n" -}}
{{- end -}}
{{- end -}}
{{- with ($demo.throttle | default dict).userRate -}}
{{- if not (regexMatch "^[1-9][0-9]*/(s|sec|second|m|min|minute|h|hour|d|day)$" (toString .)) -}}
{{- fail "\n\nVisiban: demo.throttle.userRate must look like <n>/<second|minute|hour|day>, e.g. \"60000/hour\".\n" -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end }}
