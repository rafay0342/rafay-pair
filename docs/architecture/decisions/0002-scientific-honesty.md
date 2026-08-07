# ADR 0002: Provenance-first physiology

- Status: accepted
- Date: 2026-08-07

Every derived health-related value stores its source, measurement kind, algorithm version, confidence, signal quality, and timestamp. A phone-camera pulse value is always an estimate. Freshness is computed from the original measurement time; stale values cannot drive a live physiological animation.

Blood pressure is limited to manual entry and provenance-preserved operating-system health imports. No production component derives blood pressure from camera, audio, touch pressure, demographics, another physiological estimate, or an AI model.

Raw camera frames remain on the current device except during a separately entered, explicit video call. Raw breathing audio is not retained. A partner can receive only server-authorized derived events and can never start another user's sensor session.
