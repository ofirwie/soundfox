"""Taste engine — builds feature profiles and scores candidates via cosine similarity."""

import math
from dataclasses import dataclass, field

from .reccobeats import FEATURE_KEYS


@dataclass
class TasteVector:
    """Mathematical profile of what the user likes, built from audio features."""

    mean: dict[str, float] = field(default_factory=dict)
    std: dict[str, float] = field(default_factory=dict)
    min_val: dict[str, float] = field(default_factory=dict)
    max_val: dict[str, float] = field(default_factory=dict)
    sample_count: int = 0


def build_taste_vector(features_by_track: dict[str, dict[str, float]]) -> TasteVector:
    """Build a taste vector from a collection of track features.

    Calculates mean, std, min, max for each feature dimension.
    """
    if not features_by_track:
        return TasteVector()

    # Collect all values per feature
    feature_values: dict[str, list[float]] = {k: [] for k in FEATURE_KEYS}
    for features in features_by_track.values():
        for k in FEATURE_KEYS:
            if k in features:
                feature_values[k].append(features[k])

    tv = TasteVector(sample_count=len(features_by_track))

    for k in FEATURE_KEYS:
        vals = feature_values[k]
        if not vals:
            continue
        n = len(vals)
        mean = sum(vals) / n
        variance = sum((v - mean) ** 2 for v in vals) / n if n > 1 else 0
        tv.mean[k] = mean
        tv.std[k] = math.sqrt(variance)
        tv.min_val[k] = min(vals)
        tv.max_val[k] = max(vals)

    return tv


def cosine_similarity(vec_a: dict[str, float], vec_b: dict[str, float]) -> float:
    """Compute cosine similarity between two feature dicts.

    Normalizes features to 0-1 range before computing similarity.
    Returns value between -1 and 1 (higher = more similar).
    """
    # Normalize loudness and tempo to 0-1 range
    normalized_a = _normalize(vec_a)
    normalized_b = _normalize(vec_b)

    common_keys = set(normalized_a.keys()) & set(normalized_b.keys())
    if not common_keys:
        return 0.0

    dot = sum(normalized_a[k] * normalized_b[k] for k in common_keys)
    mag_a = math.sqrt(sum(normalized_a[k] ** 2 for k in common_keys))
    mag_b = math.sqrt(sum(normalized_b[k] ** 2 for k in common_keys))

    if mag_a == 0 or mag_b == 0:
        return 0.0

    return dot / (mag_a * mag_b)


def _normalize(features: dict[str, float]) -> dict[str, float]:
    """Normalize features to roughly 0-1 scale."""
    result = {}
    for k, v in features.items():
        if k == "loudness":
            # Loudness typically -60 to 0 dB
            result[k] = (v + 60) / 60
        elif k == "tempo":
            # Tempo typically 60-200 BPM
            result[k] = (v - 60) / 140
        elif k == "key":
            # Key 0-11
            result[k] = v / 11
        elif k == "mode":
            # Mode 0 or 1
            result[k] = float(v)
        else:
            # Other features already 0-1
            result[k] = v
    return result


def score_candidate(
    candidate_features: dict[str, float],
    taste: TasteVector,
) -> float:
    """Score a candidate track against the taste vector.

    Uses cosine similarity against the mean vector,
    with a penalty for features outside the taste range.
    """
    similarity = cosine_similarity(candidate_features, taste.mean)

    # Bonus/penalty based on how many features fall within 1 std of the mean
    within_range = 0
    total_features = 0
    for k in FEATURE_KEYS:
        if k in candidate_features and k in taste.mean and k in taste.std:
            total_features += 1
            diff = abs(candidate_features[k] - taste.mean[k])
            if diff <= taste.std[k] * 1.5:
                within_range += 1

    range_score = within_range / total_features if total_features > 0 else 0

    # Combined score: 70% similarity, 30% range fit
    return 0.7 * similarity + 0.3 * range_score
