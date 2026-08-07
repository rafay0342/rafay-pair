# Estimated energy expenditure

Normative for every RafayPair client. Golden vectors live in
`tests/golden/calories`.

## 1. Honesty rules

Energy expenditure from a phone is an estimate with a wide band, and the
specification requires that every surface say so. This engine enforces it
structurally:

- The output field is `estimatedKcal`. There is no field named `kcal` or
  `calories` that a screen could render without the qualifier.
- Every result carries a `confidenceBand` with an explicit low and high bound.
  Surfaces must render the band, not only the point estimate.
- Every result carries `inputsUsed`, so a reviewer can see exactly which of the
  optional user-provided values informed it.
- Every result carries `algorithmVersion`. Changing any constant below requires
  bumping it, because stored estimates would otherwise become uncomparable.

## 2. Method

The estimate is metabolic-equivalent based, which is the standard approach for
activity without direct calorimetry:

```text
estimatedKcal = met * bodyMassKg * durationHours
```

```text
ALGORITHM_VERSION = "1.0.0"
DEFAULT_BODY_MASS_KG = 70
```

`70 kg` is a documented placeholder, not a guess about the user. When it is used,
`inputsUsed` omits `bodyMass` and the confidence band widens (§4), so a result
computed without a real body mass can never be mistaken for one computed with it.

## 3. Metabolic equivalents

```text
rest             1.3
guidedBreathing  1.3
squat            5.0
bodyweightMixed  4.5
walkingInPlace   3.5
```

Squats are `5.0`, the value for vigorous calisthenics. Repetition count refines
this within the activity rather than replacing it:

```text
repsPerMinute = repetitions / durationMinutes
intensity     = clamp(0.7, 1.3, 0.7 + 0.6 * clamp(0, 1, repsPerMinute / 20))
met           = baseMet * intensity        for repetition activities
```

Twenty repetitions per minute is treated as a full-intensity effort. The clamp
keeps a burst of fast repetitions in a short session from producing an absurd
multiplier — a real risk, since `durationMinutes` appears in the denominator.

Activities without repetitions use `baseMet` unchanged.

## 4. Confidence band

```text
BASE_UNCERTAINTY        = 0.25   ±25% with full inputs
NO_BODY_MASS_PENALTY    = 0.20
SHORT_SESSION_PENALTY   = 0.10   sessions under 60 s
LOW_CONFIDENCE_PENALTY  = 0.15   pose confidence below 0.5, when supplied

uncertainty = min(0.75, BASE_UNCERTAINTY + penalties)
lowKcal     = estimatedKcal * (1 - uncertainty)
highKcal    = estimatedKcal * (1 + uncertainty)
```

```text
uncertainty <= 0.30   moderate
uncertainty <= 0.50   wide
otherwise             veryWide
```

There is no `narrow` band. A phone-derived energy estimate is never better than
±25%, and offering a label that implies precision would undercut the point.

## 5. Result

```text
CalorieEstimate = {
  estimatedKcal        rounded to one decimal
  algorithmVersion
  activity
  durationMs
  repetitions
  met                  the effective value after intensity scaling
  bodyMassKg           the value actually used
  inputsUsed           subset of: duration, repetitions, bodyMass, poseConfidence
  confidenceBand { lowKcal, highKcal, label }
}
```

A session shorter than one second, or with a non-positive duration, produces a
zero estimate with the `veryWide` band rather than a rejection: zero is the
honest answer, and there is nothing for the user to act on.

## 6. Sharing

Energy estimates are derived summaries and follow the `workout_progress` consent
grant. The estimate, its band, and its provenance may be shared; the inputs that
produced it — body mass in particular — are never transmitted as part of a
workout summary.
