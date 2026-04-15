/**
 * PagerDuty service and escalation policy configuration for VIDA Finance.
 *
 * This file defines the PagerDuty integration configuration as code.
 * It maps to the PagerDuty service, escalation policy, and routing rules
 * that should be created in the PagerDuty web UI or via Terraform.
 *
 * Escalation policy: On-call engineer → Engineering Lead (10 min) → CTO (20 min)
 *
 * Setup instructions:
 *   1. Create a PagerDuty service "VIDA Finance Production"
 *   2. Create the escalation policy with the tiers below
 *   3. Add an Events API v2 integration to the service
 *   4. Copy the routing key to PAGERDUTY_ROUTING_KEY in Railway/GitHub Secrets
 *   5. Run the railway-setup-env workflow to propagate to all services
 */

const PAGERDUTY_CONFIG = {
  service: {
    name: 'VIDA Finance Production',
    description: 'Production alerting for VIDA Finance lending platform — all microservices',
    escalation_policy: 'vida-production-escalation',
    auto_resolve_timeout: 14400,   // 4 hours
    acknowledgement_timeout: 1800, // 30 minutes
    alert_creation: 'create_alerts_and_incidents',
    alert_grouping: 'intelligent',
    alert_grouping_timeout: 300,   // 5 min window for grouping related alerts
  },

  escalation_policy: {
    name: 'VIDA Production Escalation',
    description: 'On-call → Engineering Lead → CTO',
    num_loops: 2,
    on_call_handoff_notifications: 'if_has_services',
    escalation_rules: [
      {
        escalation_delay_in_minutes: 10,
        targets: [
          { type: 'schedule_reference', id: 'vida-oncall-schedule' },
        ],
      },
      {
        escalation_delay_in_minutes: 10,
        targets: [
          { type: 'user_reference', role: 'Engineering Lead' },
        ],
      },
      {
        escalation_delay_in_minutes: 10,
        targets: [
          { type: 'user_reference', role: 'CTO' },
        ],
      },
    ],
  },

  schedule: {
    name: 'VIDA On-Call Schedule',
    description: 'Primary on-call rotation for VIDA engineering team',
    time_zone: 'America/Mexico_City',
    schedule_layers: [
      {
        name: 'Primary On-Call',
        rotation_virtual_start: '2026-01-01T00:00:00-06:00',
        rotation_turn_length_seconds: 604800, // 1 week
      },
    ],
  },

  /**
   * Severity-to-urgency mapping.
   * PagerDuty urgency determines notification behavior:
   *   - high: immediate phone call + push notification
   *   - low: email + push notification only
   */
  severity_urgency_map: {
    critical: 'high', // SEV-1: immediate phone call
    error: 'high',    // SEV-2: immediate phone call
    warning: 'low',   // SEV-3: email/push only (no page)
    info: 'low',      // SEV-4: email/push only (no page)
  },

  /**
   * Event routing rules for the PagerDuty service.
   * These determine which incidents get routed where based on payload fields.
   */
  event_rules: [
    {
      label: 'SEV-1: Infrastructure-wide failure',
      conditions: {
        operator: 'or',
        subconditions: [
          { field: 'payload.custom_details.severity_label', operator: 'equals', value: 'SEV-1' },
          { field: 'dedup_key', operator: 'contains', value: 'all-services-down' },
          { field: 'dedup_key', operator: 'contains', value: 'redis-oom' },
          { field: 'dedup_key', operator: 'contains', value: 'disbursement-stalled' },
        ],
      },
      actions: {
        severity: 'critical',
        urgency: 'high',
        annotate: 'SEV-1 incident — 15 min response required. See runbook: https://docs.vida.mx/runbooks/incident-response',
      },
    },
    {
      label: 'SEV-2: Service degradation',
      conditions: {
        operator: 'or',
        subconditions: [
          { field: 'payload.custom_details.severity_label', operator: 'equals', value: 'SEV-2' },
          { field: 'dedup_key', operator: 'contains', value: 'single-service-down' },
          { field: 'dedup_key', operator: 'contains', value: 'error-rate-high' },
          { field: 'dedup_key', operator: 'contains', value: 'metamap-outage' },
        ],
      },
      actions: {
        severity: 'error',
        urgency: 'high',
        annotate: 'SEV-2 incident — 30 min response required. See runbook: https://docs.vida.mx/runbooks/incident-response',
      },
    },
  ],
};

module.exports = PAGERDUTY_CONFIG;
