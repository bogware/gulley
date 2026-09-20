{{/* Chart name, overridable. */}}
{{- define "gulley.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Fully qualified app name. */}}
{{- define "gulley.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Common labels. */}}
{{- define "gulley.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "gulley.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* Selector labels for a given plane (pass a dict with root + plane). */}}
{{- define "gulley.selectorLabels" -}}
app.kubernetes.io/name: {{ include "gulley.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .plane }}
{{- end -}}

{{/* The image reference (tag falls back to appVersion). */}}
{{- define "gulley.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}

{{/* pullPolicy: a mutable `latest` tag is always re-pulled (IfNotPresent would pin a
     node to whatever it pulled first); otherwise the configured policy. */}}
{{- define "gulley.pullPolicy" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- if eq $tag "latest" -}}Always{{- else -}}{{ .Values.image.pullPolicy }}{{- end -}}
{{- end -}}

{{/* Per-plane SHUTDOWN_GRACE_MS: (terminationGracePeriodSeconds - preStopSleepSeconds -
     drainBufferSeconds) * 1000. Fails the render when the budget is not positive, so an
     operator cannot configure a drain that SIGKILL always cuts short. */}}
{{- define "gulley.shutdownGraceMs" -}}
{{- $g := sub (sub (int .plane.terminationGracePeriodSeconds) (int .plane.preStopSleepSeconds)) (int .plane.drainBufferSeconds) -}}
{{- if le $g 0 -}}
{{- fail (printf "%s: terminationGracePeriodSeconds (%d) must exceed preStopSleepSeconds (%d) + drainBufferSeconds (%d)" .name (int .plane.terminationGracePeriodSeconds) (int .plane.preStopSleepSeconds) (int .plane.drainBufferSeconds)) -}}
{{- end -}}
{{- mul $g 1000 -}}
{{- end -}}

{{/* preStop hook: the image is distroless (no /bin/sh), so the sleep runs in node. */}}
{{- define "gulley.preStop" -}}
exec:
  command: ['/nodejs/bin/node', '-e', 'setTimeout(function () {}, {{ mul (int .) 1000 }})']
{{- end -}}

{{/* Affinity for a plane (pass dict root + plane): the user's `affinity` override if
     set, else a soft (preferred) pod anti-affinity that spreads that plane's replicas
     across nodes by its selector labels — so one node loss can't take out all replicas.
     "preferred" keeps single-node/dev clusters schedulable. Emitted at column 0; the
     caller nindents. */}}
{{- define "gulley.affinity" -}}
{{- if .root.Values.affinity }}
{{- toYaml .root.Values.affinity }}
{{- else }}
podAntiAffinity:
  preferredDuringSchedulingIgnoredDuringExecution:
    - weight: 100
      podAffinityTerm:
        topologyKey: {{ .root.Values.defaultAntiAffinityTopologyKey }}
        labelSelector:
          matchLabels:
            app.kubernetes.io/name: {{ include "gulley.name" .root }}
            app.kubernetes.io/instance: {{ .root.Release.Name }}
            app.kubernetes.io/component: {{ .plane }}
{{- end }}
{{- end -}}

{{/* ServiceAccount name. */}}
{{- define "gulley.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "gulley.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}
