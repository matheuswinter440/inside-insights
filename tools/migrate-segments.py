#!/usr/bin/env python3
"""One-shot: collapse the free-text Segment column onto a controlled enum.

Segment feeds the per-theme segment counts on the opportunity map (map.js), and
free text had drifted to 30+ variants of roughly nine real segments
("enterprise"/"Enterprise", "large fleet"/"large fleets"/"very large fleet").

Dry run by default — prints the mapping for every distinct value and writes
nothing. Pass --apply to rewrite the CSV in place.

    python3 tools/migrate-segments.py            # review
    python3 tools/migrate-segments.py --apply    # commit to the file

Stdlib only; this repo has no dependency manifest and shouldn't gain one.
"""

import csv
import os
import sys
from collections import Counter

CSV_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'corpus_all.csv')
COLUMNS = ['Insight', 'Date', 'Description', 'Segment', 'Source', 'Source link']

# Two dimensions on purpose: account size/structure (Enterprise, Multi-entity,
# Large/Mid/Small, Prospect) and fleet composition (Pool, Specialised). The
# corpus already mixed them; forcing one dimension would discard real signal.
ENUM = [
    'Enterprise',
    'Multi-entity',
    'Large fleet',
    'Mid-market',
    'Small fleet',
    'Pool fleet',
    'Specialised fleet',
    'Prospect',
    'Unknown',
]

# Explicit old -> new. Keys are lowercased and whitespace-stripped before lookup.
# Anything not listed falls through to Unknown and is reported separately, so a
# value in the long tail can never be silently absorbed.
MAPPING = {
    # Enterprise
    'enterprise': 'Enterprise',
    'large enterprise': 'Enterprise',
    'large enterprise fleet': 'Enterprise',
    'enterprise (multi-account)': 'Enterprise',
    'enterprise (high churn risk)': 'Enterprise',
    'enterprise/mixed fleet': 'Enterprise',      # size is the actionable half
    # Multi-entity
    'multi-entity': 'Multi-entity',
    'multi-entity enterprise': 'Multi-entity',
    'multi-entity holding': 'Multi-entity',
    'multi-country enterprise': 'Multi-entity',
    'multiple accounts (regression)': 'Multi-entity',   # "(regression)" is a bug note
    # Large fleet
    'large fleet': 'Large fleet',
    'large fleets': 'Large fleet',
    'very large fleet': 'Large fleet',
    'large driver base': 'Large fleet',
    'multi-manager fleets': 'Large fleet',
    'mid-to-large fleet': 'Large fleet',
    # Mid-market
    'mid-market+': 'Mid-market',
    'mid-market': 'Mid-market',
    # Small fleet
    'small fleet': 'Small fleet',
    'small fleets': 'Small fleet',
    # Pool fleet
    'pool fleets': 'Pool fleet',
    'pool fleet': 'Pool fleet',
    'large pool fleet': 'Pool fleet',
    # Specialised fleet — composition rather than size
    'commercial/specialized fleets': 'Specialised fleet',
    'commercial/mixed fleet (de)': 'Specialised fleet',
    'mixed fleet/equipment': 'Specialised fleet',
    'logistics/cold-chain': 'Specialised fleet',
    'company-car fleets': 'Specialised fleet',
    'e-mobility fleet': 'Specialised fleet',
    'complex inspection fleets': 'Specialised fleet',
    'mobile-driver fleets': 'Specialised fleet',
    # Prospect
    'prospects': 'Prospect',
    'prospect': 'Prospect',
    # Unknown — explicitly, so they don't show up as unmapped noise
    'unknown': 'Unknown',
    '': 'Unknown',
    'unknown (bug)': 'Unknown',
    'unknown (at)': 'Unknown',
    'unknown (blocker)': 'Unknown',
    'all sizes': 'Unknown',                      # explicitly segment-agnostic
    # Not segments at all: a plan tier, two account traits, two geographies.
    # Collapsing these to Unknown loses signal a human deliberately recorded —
    # git history becomes the only record. Flagged in the report as LOSSY.
    'plus': 'Unknown',
    'high-churn-risk account': 'Unknown',
    'high-document-volume': 'Unknown',
    'france': 'Unknown',
    'ireland/insurance-driven': 'Unknown',
}

LOSSY = {
    'plus', 'high-churn-risk account', 'high-document-volume',
    'france', 'ireland/insurance-driven',
}


def resolve(raw):
    """Return (new_value, status) where status is 'mapped', 'lossy' or 'unmapped'."""
    key = (raw or '').strip().lower()
    if key in MAPPING:
        return MAPPING[key], ('lossy' if key in LOSSY else 'mapped')
    return 'Unknown', 'unmapped'


def main():
    apply_changes = '--apply' in sys.argv

    # The committed corpus uses CRLF. Sniff it rather than assuming, and write
    # the same terminator back — otherwise every line reformats and `git blame`
    # on every card points at this migration instead of when the card was added.
    with open(CSV_PATH, 'rb') as fh:
        newline = '\r\n' if b'\r\n' in fh.read() else '\n'

    with open(CSV_PATH, newline='', encoding='utf-8') as fh:
        rows = list(csv.DictReader(fh))

    if not rows:
        sys.exit('corpus is empty or unreadable')

    missing = [c for c in COLUMNS if c not in rows[0]]
    if missing:
        sys.exit(f'corpus is missing expected columns: {missing}')

    counts = Counter((r.get('Segment') or '').strip() for r in rows)
    buckets = {'mapped': [], 'lossy': [], 'unmapped': []}
    for raw, n in counts.items():
        new, status = resolve(raw)
        buckets[status].append((raw, new, n))

    for key in buckets:
        buckets[key].sort(key=lambda t: (-t[2], t[0].lower()))

    print(f'{len(rows)} rows, {len(counts)} distinct Segment values\n')

    print('=== mapped ===')
    for raw, new, n in buckets['mapped']:
        arrow = '(unchanged)' if raw == new else f'-> {new}'
        print(f'  {n:4d}  {raw!r:42} {arrow}')

    if buckets['lossy']:
        print('\n=== LOSSY: not segments, collapsed to Unknown ===')
        print('  These carry real signal that only git history will preserve.')
        for raw, new, n in buckets['lossy']:
            print(f'  {n:4d}  {raw!r:42} -> {new}')

    if buckets['unmapped']:
        print('\n=== UNMAPPED: no rule matched, defaulting to Unknown ===')
        print('  Read these carefully — add a MAPPING rule if any deserves a real segment.')
        for raw, new, n in buckets['unmapped']:
            print(f'  {n:4d}  {raw!r:42} -> {new}')
    else:
        print('\n=== UNMAPPED: none — every distinct value has an explicit rule ===')

    after = Counter(resolve(r.get('Segment'))[0] for r in rows)
    print(f'\n=== result: {len(counts)} values -> {len(after)} ===')
    for value in ENUM:
        if after.get(value):
            print(f'  {after[value]:4d}  {value}')
    changed = sum(1 for r in rows
                  if (r.get('Segment') or '').strip() != resolve(r.get('Segment'))[0])
    print(f'\n{changed} of {len(rows)} rows change value.')

    if not apply_changes:
        print('\nDry run — nothing written. Re-run with --apply once the mapping reads right.')
        return

    for r in rows:
        r['Segment'] = resolve(r.get('Segment'))[0]

    # Rewrite with the original column order and line terminator, so the diff is
    # confined to the rows whose Segment actually changed.
    with open(CSV_PATH, 'w', newline='', encoding='utf-8') as fh:
        writer = csv.DictWriter(fh, fieldnames=COLUMNS, lineterminator=newline,
                                extrasaction='ignore')
        writer.writeheader()
        writer.writerows(rows)

    print(f'\nWrote {CSV_PATH}. Review with: git diff --stat data/corpus_all.csv')


if __name__ == '__main__':
    main()
