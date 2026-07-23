# Threshold Calibration Log

Observed similarity band (as of 2026-07-23, 29 folders / 52 links / 186 screening decisions): **0.46 - 0.79**.
Current thresholds: LOW_SIM 0.45 (raised from 0.35 per observed floor), HIGH_SIM 0.75, CAND_THRESHOLD 0.4, SIM_THRESHOLD 0 (off).

## Entries

1. **2026-07-23 - Capture-1 soft miss (middle-band under-linking).** "GPU Upgrade Before August" screened
   against Alleah-project folders at sim 0.461-0.481; Haiku bucketed all `nothing`, none escalated, no links
   drawn - despite a plausible real relation (GPU upgrade is *for* the local-model plan). Decision: no threshold
   surgery on the middle band yet. Revisit once clustering shows structure - if GPU and the Alleah-project
   folders land in one cluster, the screener's `nothing` at ~0.47 was a miss and the screener prompt (or a
   maybe-bias below 0.55) should be reconsidered. screen_log rows preserved as the answer key.
