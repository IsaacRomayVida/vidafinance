"""
Tests for the prompt template loader.

Verifies that prompt templates are loaded from disk, parsed correctly,
and rendered with variable substitution.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from prompts.loader import (
    _parse_frontmatter,
    _parse_sections,
    get_model_config,
    get_system_prompt,
    load_prompt,
    preload_all,
    render_user_prompt,
    _cache,
)


STAGE5_TEMPLATE = "stage5_risk_narrative_v1.7.0"


# ── Frontmatter parsing ─────────────────────────────────────────────────────


def test_parse_frontmatter_valid():
    content = '---\nversion: "1.7.0"\nstage: 5\n---\n\nBody here.'
    meta, body = _parse_frontmatter(content)
    assert meta["version"] == "1.7.0"
    assert meta["stage"] == "5"
    assert "Body here." in body


def test_parse_frontmatter_missing():
    content = "No frontmatter here."
    meta, body = _parse_frontmatter(content)
    assert meta == {}
    assert body == content


# ── Section parsing ──────────────────────────────────────────────────────────


def test_parse_sections_splits():
    body = "# System Prompt\n\nSystem content.\n\n# User Prompt Template\n\nUser content."
    system, user = _parse_sections(body)
    assert "System content." in system
    assert "User content." in user
    assert "# System Prompt" not in system


def test_parse_sections_no_user():
    body = "# System Prompt\n\nOnly system."
    system, user = _parse_sections(body)
    assert "Only system." in system
    assert user == ""


# ── Template loading ─────────────────────────────────────────────────────────


def test_load_stage5_template():
    _cache.clear()
    template = load_prompt(STAGE5_TEMPLATE)
    assert template["metadata"]["version"] == "1.7.0"
    assert template["metadata"]["stage"] == "5"
    assert len(template["system"]) > 100
    assert len(template["user_template"]) > 100


def test_load_template_cached():
    _cache.clear()
    t1 = load_prompt(STAGE5_TEMPLATE)
    t2 = load_prompt(STAGE5_TEMPLATE)
    assert t1 is t2


def test_load_template_not_found():
    with pytest.raises(FileNotFoundError):
        load_prompt("nonexistent_prompt_v99")


# ── System prompt content ───────────────────────────────────────────────────


def test_system_prompt_contains_metamap():
    system = get_system_prompt(STAGE5_TEMPLATE)
    assert "MetaMap" in system


def test_system_prompt_no_legacy_vendors():
    system = get_system_prompt(STAGE5_TEMPLATE)
    for vendor in ["Truora", "Sardine", "EFL"]:
        assert vendor not in system, f"System prompt still references {vendor}"


def test_system_prompt_contains_json_schema():
    system = get_system_prompt(STAGE5_TEMPLATE)
    assert "risk_level" in system
    assert "summary" in system
    assert "key_signals" in system
    assert "recommendation" in system
    assert "confidence" in system


def test_system_prompt_contains_risk_levels():
    system = get_system_prompt(STAGE5_TEMPLATE)
    for level in ["low", "medium", "high", "critical"]:
        assert level in system


def test_system_prompt_contains_recommendations():
    system = get_system_prompt(STAGE5_TEMPLATE)
    for rec in ["approve", "reject", "needs_info"]:
        assert rec in system


# ── User template content ───────────────────────────────────────────────────


def test_user_template_has_placeholders():
    template = load_prompt(STAGE5_TEMPLATE)
    user = template["user_template"]
    expected_placeholders = [
        "{loan_id}",
        "{applicant_name}",
        "{metamap_identity_json}",
        "{metamap_criminal_json}",
        "{metamap_device_json}",
        "{bureau_data_json}",
        "{riskseal_json}",
        "{repayment_probability",
        "{shap_explanations_json}",
        "{anomaly_flags_json}",
        "{escalation_reason}",
    ]
    for ph in expected_placeholders:
        assert ph in user, f"Missing placeholder: {ph}"


def test_user_template_no_legacy_vendors():
    template = load_prompt(STAGE5_TEMPLATE)
    user = template["user_template"]
    for vendor in ["Truora", "Sardine", "EFL"]:
        assert vendor not in user, f"User template still references {vendor}"


# ── Rendering ────────────────────────────────────────────────────────────────


def test_render_user_prompt():
    rendered = render_user_prompt(
        STAGE5_TEMPLATE,
        loan_id="LOAN-001",
        applicant_name="Test User",
        curp_hash="abc123",
        employer_name="ACME Corp",
        employer_tier=1,
        monthly_salary=15000.00,
        employment_tenure_months=24,
        principal_amount=3000.00,
        loan_to_salary_ratio=0.20,
        metamap_identity_json='{"status": "verified"}',
        metamap_criminal_json='{"result": "clean"}',
        metamap_device_json='{"risk": "low"}',
        bureau_data_json='{"score": 650}',
        riskseal_json='{"score": 72}',
        repayment_probability=0.7500,
        model_version="logistic_v1.0",
        approval_threshold=0.65,
        shap_explanations_json="[]",
        anomaly_flags_json='{"velocity": false}',
        escalation_reason="Bureau score below threshold",
    )
    assert "LOAN-001" in rendered
    assert "Test User" in rendered
    assert "ACME Corp" in rendered
    assert "verified" in rendered


def test_render_user_prompt_missing_keys_default():
    """Missing keys should render as {key_name} instead of raising."""
    rendered = render_user_prompt(STAGE5_TEMPLATE, loan_id="LOAN-002")
    assert "LOAN-002" in rendered
    # Missing keys should not raise, should stay as placeholder
    assert "{applicant_name}" in rendered


# ── Model config ─────────────────────────────────────────────────────────────


def test_get_model_config():
    config = get_model_config(STAGE5_TEMPLATE)
    assert config["model"] == "claude-sonnet-4-20250514"
    assert config["max_tokens"] == 1200


# ── Preload ──────────────────────────────────────────────────────────────────


def test_preload_all():
    _cache.clear()
    loaded = preload_all()
    assert STAGE5_TEMPLATE in loaded
    assert len(loaded) >= 1
