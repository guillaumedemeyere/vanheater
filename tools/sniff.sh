#!/usr/bin/env bash
# READ-ONLY MQTT sniffer: subscribes to <prefix>/# and logs to captures/. Never publishes.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
mkdir -p captures
args=(-h "$MQTT_HOST" -p "$MQTT_PORT"
      -i "dh-sniffer-$$-$RANDOM" -q 0 -v -t "${MQTT_TOPIC_PREFIX}/#")
[ -n "${MQTT_USER:-}" ] && args+=(-u "$MQTT_USER" -P "$MQTT_PASSWORD")
[ "${MQTT_TLS:-true}" = "true" ] && args+=(--capath /etc/ssl/certs)
exec docker run --rm -i --network host -v /etc/ssl/certs:/etc/ssl/certs:ro \
  eclipse-mosquitto:2 mosquitto_sub "${args[@]}" | tee -a "captures/$(date +%F-%H%M%S).log"
